// 每日优惠情报：多来源优惠抓取与聚合。
//
// 数据来源（全部服务端 fetch，见 DATA-PLAN.md 的实测记录）：
// - RSS：V2EX 推广、NodeSeek、小众软件、果核剥壳、异次元软件世界
// - LINUX DO 福利羊毛：直连 Discourse RSS 被 Cloudflare 403，改走
//   Jina 阅读器代理（r.jina.ai）并带 `X-Return-Format: html`，让 Jina 原样
//   返回 RSS XML（含每帖正文 description），走通用 RSS 解析，能拿到摘要；
//   若 Jina 仍返回 Markdown，则退回 parseJinaMarkdown 只取标题/链接/时间。
//   失败时照旧如实记入来源状态，绝不造假数据。
//
// 规则：按原文链接去重；只保留近 7 天；已领/收藏状态存在条目行上，
// 刷新只更新内容字段，永不覆盖用户状态。

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "./schema";
import { aiEnabled, scorePendingDeals } from "./ai";

type Category = "免费白嫖" | "限免" | "低价优惠" | "会员订阅" | "游戏" | "AI 相关" | "VPS/云服务" | "代理/机场" | "软件工具" | "交易/求购" | "讨论/资讯" | "其他";

interface RawDeal {
  title: string;
  link: string;
  summary: string;
  publishedAt: number | null;
  expiresAt: number | null;
  category: Category;
}

interface SourceDef {
  key: string;
  name: string;
  kind: "rss" | "jina";
  url: string;
  headers?: Record<string, string>;
}

const SOURCES: SourceDef[] = [
  { key: "v2ex", name: "V2EX 推广", kind: "rss", url: "https://www.v2ex.com/feed/promotions.xml" },
  { key: "nodeseek", name: "NodeSeek", kind: "rss", url: "https://rss.nodeseek.com/" },
  { key: "appinn", name: "小众软件", kind: "rss", url: "https://www.appinn.com/feed/" },
  { key: "ghxi", name: "果核剥壳", kind: "rss", url: "https://www.ghxi.com/feed" },
  { key: "iplaysoft", name: "异次元软件世界", kind: "rss", url: "https://www.iplaysoft.com/feed" },
  {
    key: "linuxdo",
    name: "LINUX DO 福利羊毛",
    kind: "jina",
    url: "https://r.jina.ai/https://linux.do/c/welfare/36.rss",
    // 让 Jina 返回原始 RSS XML 而不是 Markdown，保留正文摘要
    headers: { "X-Return-Format": "html", "X-No-Cache": "true" },
  },
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const PER_SOURCE_CAP = 40;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- 息知微信推送（服务端 only，Key 永不下发前端） ----------
// Key 只存服务端 app_settings 表（key=xizhi_key），永不写死进源码、
// 永不下发前端；任何接口返回都不包含 Key 或完整推送端点。
// 表内无 Key 时返回空字符串、推送跳过（fail closed）；新部署时把各自的
// Key 写入该表即可（见导出包 README 的配置说明）。
const XIZHI_KEY_SETTING = "xizhi_key";

// ---------- 推送价值过滤 ----------
// 本轮新增不一股脑全推：按标题（+简介）算价值分，只推达标的。
// 各来源需价值分 ≥2 且未命中硬排除（交易/讨论/水帖）。

const PUSH_STRONG_SIGNALS = [
  "免费",
  "限免",
  "喜加一",
  "白嫖",
  "赠送",
  "免费领",
  "0元",
  "0 元",
  "优惠码",
  "空投",
  "红包",
  "抽奖",
  "大促",
  "直降",
  "史低",
] as const;

const PUSH_WEAK_SIGNALS = [
  "折扣",
  "促销",
  "试用",
  "会员",
  "特价",
  "优惠",
  "活动",
  "首充",
  "充值",
  "开通",
] as const;

// 硬排除：明确的交易/讨论/水帖标记，命中直接不推。
// 「收」只认【收 /【出 这类明确标记，避免误伤「收藏」「回收」等正常词。
const PUSH_HARD_EXCLUDES = [
  // 自荐 / 产品推广 / API 中转与代充类（V2EX 推广区、LINUX DO 常见），只展示不推送
  "自荐",
  "分享我们的产品",
  "我们的产品",
  "我做了",
  "做了个",
  "做了一个",
  "[推广]",
  "【推广】",
  "中转",
  "代充",
  "直充",
  "入群",
  "倍率",
  "【收",
  "【出",
  "求购",
  "出售",
  "转让",
  "交流",
  "留档",
  "测评",
  "评测",
  "签到帖",
] as const;

// 软扣分：疑问/讨论类词，拿不准不硬排除，命中一组扣 2 分。
const PUSH_SOFT_PENALTIES = ["为什么", "为啥", "有人", "怎么"] as const;

interface PushCandidate {
  id?: number;
  title: string;
  summary: string;
  source: string;
  sourceKey: string;
  link: string;
  publishedAt: number | null;
  category: string;
  expiresAt: number | null;
  /** AI 价值分 0~1；null/undefined 表示没有 AI 评分，退回关键词规则 */
  aiScore?: number | null;
}

function isHardExcluded(title: string): boolean {
  for (const kw of PUSH_HARD_EXCLUDES) {
    if (title.includes(kw)) return true;
  }
  // 疑问句结尾：……吗？/吗?/？/? 一律视为讨论帖
  const t = title.trim();
  if (/[吗?？]$/.test(t) || t.includes("吗？") || t.includes("吗?")) return true;
  return false;
}

// 价值分：强信号命中任一 +2，弱信号命中任一 +1（同组不叠加），
// 疑问/讨论类软词命中 -2。返回 null 表示被硬排除。
function scorePushValue(c: PushCandidate): number | null {
  if (isHardExcluded(c.title)) return null;
  const text = `${c.title} ${c.summary}`;
  let score = 0;
  if (PUSH_STRONG_SIGNALS.some((kw) => text.includes(kw))) score += 2;
  if (PUSH_WEAK_SIGNALS.some((kw) => text.includes(kw))) score += 1;
  if (PUSH_SOFT_PENALTIES.some((kw) => c.title.includes(kw))) score -= 2;
  return score;
}

const PUSH_MAX_ITEMS = 8;
const PUSH_MIN_SCORE = 2;
// 有 AI 评分时：AI 分 ≥ 0.3 才推（实测分布偏低：≥0.3 约占前 10%，0.2~0.3 多为中转站/代充推广），按 AI 分排序（硬排除照旧生效）
const PUSH_MIN_AI_SCORE = 0.3;

// 从本轮新增里挑值得推的：达标（分 ≥2、未硬排除），
// 按分数高→低、同分按发布时间新→旧，最多 PUSH_MAX_ITEMS 条。
function selectPushDeals(
  candidates: PushCandidate[],
): { picked: PushCandidate[]; eligibleCount: number } {
  const scored: { c: PushCandidate; score: number }[] = [];
  for (const c of candidates) {
    if (NON_DEAL_CATEGORIES.has(c.category)) continue;
    if (c.aiScore != null) {
      if (!isHardExcluded(c.title) && c.aiScore >= PUSH_MIN_AI_SCORE) scored.push({ c, score: c.aiScore });
      continue;
    }
    // 无 AI 分：关键词规则，映射到与 AI 分可比的区间（2 分≈0.5，每多 1 分 +0.05）
    const s = scorePushValue(c);
    if (s != null && s >= PUSH_MIN_SCORE) scored.push({ c, score: 0.2 + s * 0.05 });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.c.publishedAt ?? 0) - (a.c.publishedAt ?? 0);
  });
  // 同标题（不同链接的重复帖）只推一条
  const seenTitles = new Set<string>();
  const unique = scored.filter(({ c }) => {
    const k = c.title.replace(/\s+/g, "").toLowerCase();
    if (seenTitles.has(k)) return false;
    seenTitles.add(k);
    return true;
  });
  return {
    picked: unique.slice(0, PUSH_MAX_ITEMS).map((s) => s.c),
    eligibleCount: scored.length,
  };
}

// Markdown 推送正文（已在用户手机双路实测：息知会把 Markdown 链接渲染成
// 可点击链接；HTML 会露标签、纯文本裸链接点不了，都弃用）。
// 每条一个段落块：第 1 行「[来源 · 标题](链接)」标题即链接；其后空一行接
// 第 2 段（简介截断 80 字 + 类别/到期，有才写）；条目间空一行分段
// （Markdown 单换行会被合并，必须空行）；结尾一行汇总。

// 标题里的半角 [ ] ( ) 会破坏 Markdown 链接语法，替换为全角保证链接不破；
// 链接里的括号/空白做百分号转义兜底。
function escapeMdLinkText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    .replace(/\(/g, "（")
    .replace(/\)/g, "）")
    .trim();
}

function escapeMdLinkUrl(u: string): string {
  return u.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
}

// AI 价值分醒目展示：「🔥 82 分 · 高价值 ▰▰▰▰▰▰▰▰▱▱」作为每条的第一行。
// 模型原始分偏低（≥0.4 已是头部），展示时按 0.5 封顶映射到 0~100，更符合直觉。
function aiDisplayScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round((score / 0.5) * 100)));
}

function aiTier(score: number): { icon: string; label: string } {
  if (score >= 0.4) return { icon: "🔥", label: "高价值" };
  if (score >= 0.3) return { icon: "👍", label: "值得看" };
  if (score >= 0.15) return { icon: "🙂", label: "一般" };
  return { icon: "💤", label: "价值低" };
}

function scoreBar(pts: number): string {
  const n = Math.round(pts / 10);
  return "▰".repeat(n) + "▱".repeat(10 - n);
}

function buildScoreLine(d: PushCandidate): string {
  if (d.aiScore == null) return "📋 **规则筛选**（暂无 AI 分）";
  const pts = aiDisplayScore(d.aiScore);
  const t = aiTier(d.aiScore);
  return `${t.icon} **AI ${pts} 分 · ${t.label}**　${scoreBar(pts)}`;
}

function buildPushBlock(d: PushCandidate, index?: number): string {
  const lines: string[] = [];
  lines.push(`${index != null ? `**${index}.** ` : ""}${buildScoreLine(d)}`);
  lines.push(`[${escapeMdLinkText(d.title)}](${escapeMdLinkUrl(d.link)})`);
  const meta: string[] = [d.source, d.category];
  if (d.publishedAt != null) {
    const bj = new Date(d.publishedAt + 8 * 3600 * 1000);
    const hh = String(bj.getUTCHours()).padStart(2, "0");
    const mm = String(bj.getUTCMinutes()).padStart(2, "0");
    meta.push(`${bj.getUTCMonth() + 1}/${bj.getUTCDate()} ${hh}:${mm} 发布`);
  }
  if (d.expiresAt != null) {
    const dt = new Date(d.expiresAt + 8 * 3600 * 1000);
    meta.push(`⏰ ${dt.getUTCMonth() + 1}/${dt.getUTCDate()} 到期`);
  }
  lines.push(meta.join(" · "));
  const summary = d.summary.trim();
  if (summary) lines.push(`> ${truncate(summary.replace(/\s+/g, " "), 80)}`);
  // Markdown 单换行会被合并，段落之间必须空行
  return lines.join("\n\n");
}

function buildPushContent(picked: PushCandidate[], totalNew: number): string {
  const body = picked.map((d, i) => buildPushBlock(d, i + 1)).join("\n\n---\n\n");
  const footer = `……本轮共新增 ${totalNew} 条，打开页面查看全部与 AI 排行榜`;
  return body ? `${body}\n\n${footer}` : footer;
}

// 推送标题会显示在微信通知栏：直接带上最值得看的那条，点开前就知道是什么。
function buildPushTitle(picked: PushCandidate[]): string {
  const top = picked[0];
  if (!top) return "每日优惠情报";
  const head = truncate(top.title.replace(/\s+/g, " ").trim(), 20);
  const score = top.aiScore != null ? `${aiDisplayScore(top.aiScore)}分 ` : "";
  return picked.length > 1 ? `🔥${score}${head} 等 ${picked.length} 条` : `🔥${score}${head}`;
}

// ---------- 推送节奏 ----------
// 候选 = 近 24 小时首次出现、还没推过、没标记已领的条目（不只本轮新增），
// 这样推送失败或静默时段积压的条目会在下一轮自动补推，且同一条永不重复推。
const PUSH_WINDOW_MS = 24 * 60 * 60 * 1000;

// 静默时段（北京时间，默认 23 点至次日 8 点不推，积压到早上一起推）。
// 可在 app_settings 写 push_quiet_hours = "23-8"；写 "off" 关闭静默。
async function inQuietHours(ctx: Ctx, now: number): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, "push_quiet_hours"));
  const raw = rows[0]?.value?.trim() ?? "23-8";
  if (raw === "off") return false;
  const m = raw.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const hour = new Date(now + 8 * 3600 * 1000).getUTCHours(); // 北京时间
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

// 推送来源开关：app_settings.push_sources_off = 不推送的来源 key（逗号分隔）。
// 存「关闭」名单而不是「开启」名单：以后新增的来源默认推送。
const PUSH_SOURCES_OFF = "push_sources_off";

async function getPushSourcesOff(ctx: Ctx): Promise<Set<string>> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, PUSH_SOURCES_OFF));
  return new Set((rows[0]?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean));
}

async function loadPushCandidates(ctx: Ctx, now: number): Promise<PushCandidate[]> {
  const db = ctx.db<typeof schema>();
  const off = await getPushSourcesOff(ctx);
  const rows = await db
    .select()
    .from(schema.deals)
    .where(
      and(
        isNull(schema.deals.pushedAt),
        eq(schema.deals.claimed, 0),
        gte(schema.deals.firstSeenAt, now - PUSH_WINDOW_MS),
      ),
    );
  return rows
    .filter((d) => d.expiresAt == null || d.expiresAt > now) // 已过期的不推
    .filter((d) => !off.has(sourceKeyFromSourceName(d.source))) // 用户关闭推送的来源
    .map((d) => ({
      id: d.id,
      title: d.title,
      summary: d.summary,
      source: d.source,
      sourceKey: sourceKeyFromSourceName(d.source),
      link: d.link,
      publishedAt: d.publishedAt,
      category: effectiveCategory(d),
      expiresAt: d.expiresAt,
      aiScore: d.aiScore,
    }));
}

async function setAppSetting(ctx: Ctx, key: string, value: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db
    .insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } });
}

async function getXizhiKey(ctx: Ctx): Promise<string> {
  const db = ctx.db<typeof schema>();
  try {
    const rows = await db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, XIZHI_KEY_SETTING));
    const existing = rows[0]?.value?.trim();
    if (existing) return existing;
    return "";
  } catch {
    return "";
  }
}

async function recordPushResult(ctx: Ctx, ok: boolean, message: string): Promise<void> {
  try {
    await setAppSetting(ctx, "xizhi_last_push_at", String(Date.now()));
    await setAppSetting(ctx, "xizhi_last_push_ok", ok ? "1" : "0");
    await setAppSetting(ctx, "xizhi_last_push_msg", message.slice(0, 300));
  } catch {
    // 记录失败不影响主流程
  }
}

type XizhiResult = { ok: boolean; message: string };

function parseXizhiBody(text: string): XizhiResult {
  try {
    const j = JSON.parse(text) as { code?: unknown; msg?: unknown };
    const code = typeof j.code === "number" ? j.code : Number(j.code);
    const msg = typeof j.msg === "string" ? j.msg : "";
    if (code === 200) return { ok: true, message: msg || "推送成功" };
    return { ok: false, message: msg || `推送接口返回 code=${String(j.code)}` };
  } catch {
    return { ok: false, message: "推送接口返回非 JSON 内容" };
  }
}

async function sendXizhiPush(ctx: Ctx, title: string, content: string): Promise<XizhiResult> {
  const key = await getXizhiKey(ctx);
  if (!key) {
    const result: XizhiResult = {
      ok: false,
      message: "未配置推送 Key：在 .env 中填写 XIZHI_KEY 后重启服务",
    };
    console.error(`[xizhi] push skipped: ${result.message}`);
    await recordPushResult(ctx, false, result.message);
    return result;
  }
  const endpoint = `https://xizhi.qqoq.net/${key}.send`;
  // 优先 POST form-urlencoded
  let postNetworkError: Error | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const body = new URLSearchParams({ title, content });
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: body.toString(),
        signal: ctrl.signal,
      });
      const text = await res.text();
      const parsed = parseXizhiBody(text);
      if (!res.ok && !parsed.ok) {
        const result = { ok: false, message: parsed.message || `HTTP ${res.status}` };
        console.error(`[xizhi] push failed: ${result.message}`);
        await recordPushResult(ctx, false, result.message);
        return result;
      }
      if (parsed.ok) {
        console.log(`[xizhi] push ok: ${title}`);
      } else {
        console.error(`[xizhi] push failed: ${parsed.message}`);
      }
      await recordPushResult(ctx, parsed.ok, parsed.message);
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    postNetworkError = e instanceof Error ? e : new Error(String(e));
    console.error(`[xizhi] POST network error, retrying with GET: ${postNetworkError.message}`);
  }
  // 网络失败时用 GET 重试一次
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const qs = new URLSearchParams({ title, content });
      const res = await fetch(`${endpoint}?${qs.toString()}`, {
        method: "GET",
        headers: { "User-Agent": UA },
        signal: ctrl.signal,
      });
      const text = await res.text();
      const parsed = parseXizhiBody(text);
      if (parsed.ok) {
        console.log(`[xizhi] push ok via GET retry: ${title}`);
      } else {
        console.error(`[xizhi] push failed via GET retry: ${parsed.message}`);
      }
      await recordPushResult(ctx, parsed.ok, parsed.message);
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const message = `推送网络失败：${e instanceof Error ? e.message : String(e)}${postNetworkError ? `（POST：${postNetworkError.message}）` : ""}`;
    console.error(`[xizhi] ${message}`);
    await recordPushResult(ctx, false, message);
    return { ok: false, message };
  }
}

// 失败重试：限流（429）、服务端错误（5xx）、超时/网络错误最多再试 2 次，间隔 3s、8s。
// Muse 等托管平台出口 IP 多应用共用，Jina 免费额度按 IP 计，偶发 429 很常见。
const RETRY_DELAYS_MS = [3000, 8000];

async function fetchWithRetry(url: string, extraHeaders?: Record<string, string>): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fetchText(url, extraHeaders);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const m = msg.match(/^HTTP (\d+)/);
      const retryable = !m || m[1] === "429" || Number(m[1]) >= 500;
      if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(msg === "HTTP 429" ? "HTTP 429，被限流，可配置 JINA_API_KEY 解决" : msg);
}

// 可选 Jina Key（app_settings.jina_key）：按 Key 计额度，不再和同 IP 的其他人共用免费额度。
async function getJinaKey(ctx: Ctx): Promise<string> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, "jina_key"));
  return rows[0]?.value?.trim() ?? "";
}

async function fetchText(url: string, extraHeaders?: Record<string, string>): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, application/xml, text/xml, */*",
        ...extraHeaders,
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (!body.trim()) throw new Error("返回内容为空");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 文本工具 ----------

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function stripHtml(s: string): string {
  return decodeEntities(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function tagText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  if (!m || m[1] == null) return null;
  return decodeEntities(m[1]).trim();
}

// 从标题/简介里提取明确写出的到期日；没有就不编，返回 null。
function extractExpiry(text: string, now: number): number | null {
  const candidates: number[] = [];
  const push = (y: number, mo: number, d: number) => {
    const t = new Date(y, mo - 1, d, 23, 59, 59).getTime();
    if (Number.isFinite(t) && t > now - 2 * 24 * 3600 * 1000 && t < now + 370 * 24 * 3600 * 1000) {
      candidates.push(t);
    }
  };
  for (const m of text.matchAll(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/g)) {
    push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  for (const m of text.matchAll(/(20\d{2})年(\d{1,2})月(\d{1,2})日/g)) {
    push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const year = new Date(now).getFullYear();
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/g)) {
    let y = year;
    let t = new Date(y, Number(m[1]) - 1, Number(m[2]), 23, 59, 59).getTime();
    if (t < now - 30 * 24 * 3600 * 1000) {
      y += 1;
      t = new Date(y, Number(m[1]) - 1, Number(m[2]), 23, 59, 59).getTime();
    }
    if (t > now - 2 * 24 * 3600 * 1000 && t < now + 370 * 24 * 3600 * 1000) candidates.push(t);
  }
  for (const m of text.matchAll(/(\d{1,2})月(\d{1,2})日/g)) {
    let y = year;
    let t = new Date(y, Number(m[1]) - 1, Number(m[2]), 23, 59, 59).getTime();
    if (t < now - 30 * 24 * 3600 * 1000) {
      y += 1;
      t = new Date(y, Number(m[1]) - 1, Number(m[2]), 23, 59, 59).getTime();
    }
    if (t > now - 2 * 24 * 3600 * 1000 && t < now + 370 * 24 * 3600 * 1000) candidates.push(t);
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

// ---------- 分类 ----------

// AI 相关关键词：中文/短语直接包含匹配；英文词用「前后不是英文字母」的
// 词边界匹配，避免子串误伤（如 Airalo、email 里的 ai、散落在长单词里的 glm）。
const AI_PHRASE_KEYWORDS = [
  "通义千问",
  "豆包",
  "文心一言",
  "智谱",
  "讯飞星火",
  "人工智能",
  "大模型",
  "中转站",
  "api 中转",
] as const;

const AI_EN_KEYWORDS = [
  "chatgpt",
  "openai",
  "gpt",
  "gemini",
  "claude",
  "deepseek",
  "grok",
  "copilot",
  "llama",
  "mistral",
  "perplexity",
  "midjourney",
  "sora",
  "dall-e",
  "dalle",
  "stable diffusion",
  "cursor",
  "qwen",
  "kimi",
  "glm",
  "llm",
  "aigc",
  "ai",
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const AI_EN_REGEXES = AI_EN_KEYWORDS.map(
  (kw) => new RegExp(`(?<![a-z])${escapeRegExp(kw)}(?![a-z])`),
);

function isAiRelated(text: string): boolean {
  const lower = text.toLowerCase();
  for (const kw of AI_PHRASE_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  for (const re of AI_EN_REGEXES) {
    if (re.test(lower)) return true;
  }
  return false;
}

function sourceKeyFromSourceName(name: string): string {
  return SOURCES.find((s) => s.name === name)?.key ?? "";
}

// 优先级：游戏 → AI 相关 → 会员订阅 → 限免 → 低价优惠 → 免费白嫖 → 其他。
// AI 排在会员订阅之前，AI 会员/订阅类帖子归 AI 相关。
function classify(_sourceKey: string, title: string, summary: string): Category {
  const t = `${title} ${summary}`;
  const tt = title.trim();
  if (/^[【\[]?\s*(出|收|求|转)[】\]\s]|^\d+\s*(出|收)|^(大降价|低价|亏本|白菜价)?出(?!门|现|发|行|来|了|品|圈|游|国|租)\S|^收\s*\d|出售|收购|求购|转让|拼车|【收|【出/.test(tt)) return "交易/求购";
  if (/[吗呢?？]\s*$|^(请问|求推荐|求助|有没有|有人|怎么|为什么|为啥)/.test(tt)) return "讨论/资讯";
  if (/喜加一|steam|epic|gog|游戏本体|免费游戏/i.test(t) || /游戏/.test(title)) return "游戏";
  if (isAiRelated(t)) return "AI 相关";
  if (/代理\s*ip|住宅\s*ip|家宽|机场|vpn|socks5|加速器|动态\s*ip|静态\s*ip/i.test(t)) return "代理/机场";
  if (/vps|服务器|云主机|独服|独立服务器|cdn|域名|带宽|\d+\s*[GT]B?\s*(硬盘|流量|内存)|\d+M\s*\d+G/i.test(t)) return "VPS/云服务";
  if (/会员|订阅|vip|pro版|高级版|网盘会员|svip/i.test(t)) return "会员订阅";
  if (/限免|限时免费|免费领取|免费领|0元领|0 元领/.test(t)) return "限免";
  if (/折扣|优惠码|优惠券|立减|半价|特价|低价|促销|直降|秒杀|元\/年|元一年/.test(t)) return "低价优惠";
  if (/免费|白嫖|赠送|领取|抽奖|羊毛|红包|话费/.test(title)) return "免费白嫖";
  if (/\sv?\d+(\.\d+){1,3}\b|发布|更新|开源/i.test(tt)) return "软件工具";
  return "其他";
}

/** 展示/筛选/推送用的最终类别：优先 AI 分类（非「其他」占位），否则用规则分类 */
function effectiveCategory(d: { category: string; aiCategory: string | null }): string {
  // 交易帖（出/收/求开头）、问句结尾的讨论帖：标题特征明确，规则优先于 AI
  if (d.category === "交易/求购" || d.category === "讨论/资讯") return d.category;
  return d.aiCategory && d.aiCategory !== "其他" ? d.aiCategory : d.category;
}

/** 不是优惠的类别：不推送 */
const NON_DEAL_CATEGORIES = new Set(["交易/求购", "讨论/资讯"]);

// ---------- RSS / Atom 解析 ----------

function parseFeed(xml: string, source: SourceDef, now: number): RawDeal[] {
  const blocks =
    xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g) ??
    xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/g) ??
    [];
  const out: RawDeal[] = [];
  for (const block of blocks) {
    const title = stripHtml(tagText(block, "title") ?? "");
    let link = tagText(block, "link") ?? "";
    if (!link) {
      const href = block.match(/<link[^>]*href="([^"]+)"/);
      if (href && href[1]) link = decodeEntities(href[1]);
    }
    if (!title || !link.startsWith("http")) continue;
    const descRaw =
      tagText(block, "description") ?? tagText(block, "summary") ?? tagText(block, "content") ?? "";
    const summary = truncate(
      stripHtml(descRaw)
        .replace(/\s*\d+\s+posts?\s*-\s*\d+\s+participants?/gi, "")
        .replace(/\s*Read full topic\s*/gi, " ")
        .trim(),
      110,
    );
    const dateRaw = tagText(block, "pubDate") ?? tagText(block, "published") ?? tagText(block, "updated");
    const parsed = dateRaw ? Date.parse(dateRaw) : NaN;
    const publishedAt = Number.isFinite(parsed) ? parsed : null;
    out.push({
      title: truncate(title, 120),
      link,
      summary,
      publishedAt,
      expiresAt: extractExpiry(`${title} ${summary}`, now),
      category: classify(source.key, title, summary),
    });
    if (out.length >= PER_SOURCE_CAP) break;
  }
  return out;
}

// ---------- Jina 代理的 Markdown 解析（LINUX DO） ----------
//
// r.jina.ai 渲染 linux.do 分类 RSS 后返回 Markdown，每条三段：
//   ### [帖子标题](https://linux.do/t/topic/<id>)
//   [同上链接](同上链接)
//   Sat, 07 Nov 2026 23:08:31 +0000
// 该 RSS 没有正文摘要，summary 留空，不编造内容。

function parseJinaMarkdown(md: string, source: SourceDef, now: number): RawDeal[] {
  const out: RawDeal[] = [];
  const headingRe = /^###\s+\[(.+)\]\((https:\/\/linux\.do\/t\/topic\/\d+)\)\s*$/gm;
  const matches = [...md.matchAll(headingRe)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m || m[1] == null || m[2] == null) continue;
    const title = stripHtml(m[1]).trim();
    const link = m[2];
    if (!title) continue;
    // 发布时间在标题行之后、下一条标题之前的日期行里找。
    const segStart = (m.index ?? 0) + m[0].length;
    const segEnd = i + 1 < matches.length ? (matches[i + 1]?.index ?? md.length) : md.length;
    const segment = md.slice(segStart, segEnd);
    const dateMatch = segment.match(
      /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+(?:[+-]\d{4}|GMT|UTC)/,
    );
    const parsed = dateMatch ? Date.parse(dateMatch[0]) : NaN;
    const publishedAt = Number.isFinite(parsed) ? parsed : null;
    out.push({
      title: truncate(title, 120),
      link,
      summary: "",
      publishedAt,
      expiresAt: extractExpiry(title, now),
      category: classify(source.key, title, ""),
    });
    if (out.length >= PER_SOURCE_CAP) break;
  }
  return out;
}

// ---------- 仪表盘数据形状 ----------

const dealShape = z.object({
  id: z.number(),
  title: z.string(),
  summary: z.string(),
  source: z.string(),
  category: z.string(),
  categoryByAi: z.boolean(),
  link: z.string(),
  publishedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  isNew: z.boolean(),
  claimed: z.boolean(),
  favorite: z.boolean(),
  aiScore: z.number().nullable(),
  aiConfidence: z.number().nullable(),
});

const statsShape = z.object({
  lastRunAt: z.number().nullable(),
  okSources: z.number(),
  totalSources: z.number(),
  onShelf: z.number(),
  newCount: z.number(),
  errors: z.array(z.object({ source: z.string(), error: z.string() })),
  sources: z.array(z.object({ key: z.string(), name: z.string(), count: z.number(), ok: z.boolean(), push: z.boolean() })),
  aiEnabled: z.boolean(),
  aiPending: z.number(),
});

const dashboardResponse = z.object({
  stats: statsShape,
  deals: z.array(dealShape),
});

type Dashboard = z.infer<typeof dashboardResponse>;

const setDealStateResponse = z.object({ ok: z.literal(true) });

const keyStatus = z.object({ set: z.boolean(), tail: z.string(), fromEnv: z.boolean() });
const settingsResponse = z.object({
  xizhi: keyStatus,
  openrouter: keyStatus,
  jina: keyStatus,
  quietHours: z.string(),
  error: z.string().nullable().optional(),
});

async function readSettings(ctx: Ctx): Promise<z.infer<typeof settingsResponse>> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.appSettings);
  const map = new Map(rows.map((r) => [r.key, (r.value ?? "").trim()]));
  const envManaged = new Set((map.get("env_managed") ?? "").split(",").filter(Boolean));
  const st = (k: string) => {
    const v = map.get(k) ?? "";
    return { set: v !== "", tail: v.length > 8 ? v.slice(-4) : "", fromEnv: envManaged.has(k) };
  };
  return {
    xizhi: st(XIZHI_KEY_SETTING),
    openrouter: st("openrouter_key"),
    jina: st("jina_key"),
    quietHours: map.get("push_quiet_hours") || "23-8",
  };
}

const testPushResponse = z.object({ ok: z.boolean(), message: z.string() });

async function buildDashboard(ctx: Ctx): Promise<Dashboard> {
  const db = ctx.db<typeof schema>();
  const [rawDealRows, statusRows, runRows, countRows] = await Promise.all([
    db.select().from(schema.deals).orderBy(desc(schema.deals.firstSeenAt)).limit(400),
    db.select().from(schema.sourceStatus),
    db.select().from(schema.fetchRuns).orderBy(desc(schema.fetchRuns.id)).limit(1),
    db
      .select({ source: schema.deals.source, n: sql<number>`count(*)` })
      .from(schema.deals)
      .groupBy(schema.deals.source),
  ]);
  // 存量重分类：分类是系统按标题/简介派生的字段，不是用户状态。
  // 规则变更（如新增 AI 相关）后，对在架条目按现行规则重跑一遍并落库，
  // 只改 category，永不触碰 claimed/favorite；无变化时不写库。
  const dealRows: typeof rawDealRows = [];
  for (const d of rawDealRows) {
    const expected = classify(sourceKeyFromSourceName(d.source), d.title, d.summary);
    if (expected !== d.category) {
      await db
        .update(schema.deals)
        .set({ category: expected })
        .where(eq(schema.deals.id, d.id));
      dealRows.push({ ...d, category: expected });
    } else {
      dealRows.push(d);
    }
  }
  const lastRun = runRows[0] ?? null;
  const statusByName = new Map(statusRows.map((s) => [s.source, s]));
  const countByName = new Map(countRows.map((c) => [c.source, c.n]));
  const pushOff = await getPushSourcesOff(ctx);
  const errors = SOURCES.filter((s) => {
    const st = statusByName.get(s.name);
    return st != null && st.ok === 0;
  }).map((s) => ({
    source: s.name,
    error: statusByName.get(s.name)?.error ?? "未能抓取",
  }));
  return {
    stats: {
      lastRunAt: lastRun?.finishedAt ?? null,
      okSources: lastRun?.okSources ?? 0,
      totalSources: SOURCES.length,
      onShelf: dealRows.length,
      newCount: lastRun?.newCount ?? 0,
      errors,
      sources: SOURCES.map((s) => ({
        key: s.key,
        name: s.name,
        push: !pushOff.has(s.key),
        count: countByName.get(s.name) ?? 0,
        ok: statusByName.get(s.name)?.ok === 1,
      })),
      aiEnabled: await aiEnabled(ctx),
      aiPending: dealRows.filter((d) => d.aiScore == null || d.aiCategory == null).length,
    },
    deals: dealRows.map((d) => ({
      id: d.id,
      title: d.title,
      summary: d.summary,
      source: d.source,
      category: effectiveCategory(d),
      categoryByAi: effectiveCategory(d) === d.aiCategory && d.aiCategory !== d.category,
      link: d.link,
      publishedAt: d.publishedAt,
      expiresAt: d.expiresAt,
      isNew: lastRun != null && d.firstSeenAt >= lastRun.startedAt,
      claimed: d.claimed === 1,
      favorite: d.favorite === 1,
      aiScore: d.aiScore,
      aiConfidence: d.aiConfidence,
    })),
  };
}

export const Actions = {
  getDashboard: defineAction({
    description: "读取优惠仪表盘：全部在架优惠、来源健康状态与最近一轮抓取统计。",
    request: z.object({}),
    response: dashboardResponse,
    async handler(ctx): Promise<Dashboard> {
      return buildDashboard(ctx);
    },
  }),

  refreshDeals: defineAction({
    description:
      "立即执行一轮抓取：并行拉取各 RSS 来源（含经 Jina 代理的 LINUX DO），去重入库、清理 7 天前条目，返回最新仪表盘。",
    request: z.object({}),
    response: dashboardResponse,
    async handler(ctx): Promise<Dashboard> {
      const db = ctx.db<typeof schema>();
      const startedAt = Date.now();

      // 已有正在跑的一轮（3 分钟内）就直接返回现状，避免并发重复抓取。
      const recent = await db
        .select()
        .from(schema.fetchRuns)
        .orderBy(desc(schema.fetchRuns.id))
        .limit(1);
      const last = recent[0];
      if (last && last.finishedAt == null && startedAt - last.startedAt < 3 * 60 * 1000) {
        return buildDashboard(ctx);
      }

      const runInsert = await db
        .insert(schema.fetchRuns)
        .values({ startedAt })
        .returning({ id: schema.fetchRuns.id });
      const runRow = runInsert[0];
      if (!runRow) throw new Error("refreshDeals: run insert failed");

      const jinaKey = await getJinaKey(ctx);
      const results = await Promise.all(
        SOURCES.map(async (s) => {
          try {
            const headers =
              s.kind === "jina" && jinaKey ? { ...s.headers, Authorization: `Bearer ${jinaKey}` } : s.headers;
            const text = await fetchWithRetry(s.url, headers);
            // jina：优先按原始 RSS XML 解析（带摘要），不是 XML 时退回 Markdown 解析
            const looksXml = /<(rss|feed)[\s>]/.test(text.slice(0, 2000));
            const items =
              s.kind === "jina" && !looksXml
                ? parseJinaMarkdown(text, s, startedAt)
                : parseFeed(text, s, startedAt);
            if (items.length === 0) {
              return { source: s, items, error: "未能抓取：订阅源无条目" as string | null };
            }
            return { source: s, items, error: null as string | null };
          } catch (e) {
            return {
              source: s,
              items: [] as RawDeal[],
              error: `未能抓取（${e instanceof Error ? e.message : String(e)}）`,
            };
          }
        }),
      );

      const existing = await db.select({ link: schema.deals.link }).from(schema.deals);
      const existingLinks = new Set(existing.map((r) => r.link));
      let newCount = 0;
      let okSources = 0;
      const newDeals: PushCandidate[] = [];

      for (const r of results) {
        const ok = r.error == null;
        if (ok) okSources += 1;
        await db
          .insert(schema.sourceStatus)
          .values({
            source: r.source.name,
            ok: ok ? 1 : 0,
            itemCount: r.items.length,
            error: r.error,
            fetchedAt: startedAt,
          })
          .onConflictDoUpdate({
            target: schema.sourceStatus.source,
            set: {
              ok: ok ? 1 : 0,
              itemCount: r.items.length,
              error: r.error,
              fetchedAt: startedAt,
            },
          });
        for (const item of r.items) {
          if (existingLinks.has(item.link)) {
            await db
              .update(schema.deals)
              .set({
                title: item.title,
                summary: item.summary,
                source: r.source.name,
                category: item.category,
                publishedAt: item.publishedAt,
                expiresAt: item.expiresAt,
                lastSeenAt: startedAt,
              })
              .where(eq(schema.deals.link, item.link));
          } else {
            existingLinks.add(item.link);
            // 已超过 7 天保留期的旧条目不入库，也不计入本轮新增。
            if ((item.publishedAt ?? startedAt) < startedAt - SEVEN_DAYS_MS) continue;
            newCount += 1;
            newDeals.push({
              title: item.title,
              summary: item.summary,
              source: r.source.name,
              sourceKey: r.source.key,
              link: item.link,
              publishedAt: item.publishedAt,
              category: item.category,
              expiresAt: item.expiresAt,
            });
            await db.insert(schema.deals).values({
              link: item.link,
              title: item.title,
              summary: item.summary,
              source: r.source.name,
              category: item.category,
              publishedAt: item.publishedAt,
              expiresAt: item.expiresAt,
              firstSeenAt: startedAt,
              lastSeenAt: startedAt,
            });
          }
        }
      }

      // 已下线来源（如 Epic）的条目与状态一并清掉
      const activeNames = SOURCES.map((x) => x.name);
      await db.run(
        sql`delete from deals where source not in (${sql.join(activeNames.map((n) => sql`${n}`), sql`, `)})`,
      );
      await db.run(
        sql`delete from source_status where source not in (${sql.join(activeNames.map((n) => sql`${n}`), sql`, `)})`,
      );

      // 只保留近 7 天；已收藏的留着，用户自己取消。
      const cutoff = startedAt - SEVEN_DAYS_MS;
      await db.run(
        sql`delete from deals where favorite = 0 and coalesce(published_at, first_seen_at) < ${cutoff}`,
      );

      // 存量重分类：本轮没被任何来源重新返回的在架条目也按现行规则重跑分类，
      // 让新增类别（如 AI 相关）对全部存量立刻生效；只改 category。
      const allDeals = await db.select().from(schema.deals);
      for (const d of allDeals) {
        const expected = classify(sourceKeyFromSourceName(d.source), d.title, d.summary);
        if (expected !== d.category) {
          await db
            .update(schema.deals)
            .set({ category: expected })
            .where(eq(schema.deals.id, d.id));
        }
      }

      const totalRows = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.deals);
      const totalCount = totalRows[0]?.n ?? 0;

      await db
        .update(schema.fetchRuns)
        .set({
          finishedAt: Date.now(),
          newCount,
          totalCount,
          okSources,
          totalSources: SOURCES.length,
        })
        .where(eq(schema.fetchRuns.id, runRow.id));

      // 息知微信推送：本轮新增先过价值过滤，只推达标的（Markdown 格式，
      // 标题即链接可点击；HTML 露标签、纯文本裸链接不可点，均已弃用）。
      // 0 条达标就不推；推送失败只记日志/设置表，不影响刷新结果。
      // AI 价值评分：先给待评分条目打分（本轮新增优先也在其中），再把分数带进推送筛选。
      try {
        await scorePendingDeals(ctx);
        if (newDeals.length > 0) {
          const scoredRows = await db
            .select({ link: schema.deals.link, aiScore: schema.deals.aiScore })
            .from(schema.deals);
          const byLink = new Map(scoredRows.map((r) => [r.link, r.aiScore]));
          for (const d of newDeals) d.aiScore = byLink.get(d.link) ?? null;
        }
      } catch (e) {
        console.error(`[ai] scoring failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      try {
        const pushNow = Date.now();
        const candidates = await loadPushCandidates(ctx, pushNow);
        const { picked, eligibleCount } = selectPushDeals(candidates);
        const quiet = await inQuietHours(ctx, pushNow);
        console.log(
          `[xizhi] push filter: new=${newCount} pending=${candidates.length} eligible=${eligibleCount} picked=${picked.length}${quiet ? " (quiet hours, deferred)" : ""}`,
        );
        try {
          await setAppSetting(ctx, "xizhi_last_round_new", String(newCount));
          await setAppSetting(ctx, "xizhi_last_round_eligible", String(eligibleCount));
          await setAppSetting(ctx, "xizhi_last_round_pushed", picked.length > 0 ? "1" : "0");
        } catch {
          // 记录失败不影响主流程
        }
        if (picked.length > 0 && quiet) {
          console.log("[xizhi] refresh push deferred: quiet hours");
        } else if (picked.length > 0) {
          const result = await sendXizhiPush(ctx, buildPushTitle(picked), buildPushContent(picked, newCount));
          if (result.ok) {
            const ids = picked.map((p) => p.id).filter((x): x is number => x != null);
            if (ids.length > 0) {
              await db.update(schema.deals).set({ pushedAt: pushNow }).where(inArray(schema.deals.id, ids));
            }
          } else {
            console.error(`[xizhi] refresh push not sent (will retry next round): ${result.message}`);
          }
        } else {
          console.log("[xizhi] refresh push skipped: no deal passed the value filter");
        }
      } catch (e) {
        console.error(
          `[xizhi] refresh push exception (ignored): ${e instanceof Error ? e.message : String(e)}`,
        );
        try {
          await recordPushResult(ctx, false, e instanceof Error ? e.message : String(e));
        } catch {
          // ignore
        }
      }

      ctx.invalidateQueries();
      return buildDashboard(ctx);
    },
  }),

  scoreDeals: defineAction({
    description: "用 AI 给尚未评分的在架优惠打价值分（无 OpenRouter Key 时跳过），返回最新仪表盘。",
    request: z.object({}),
    response: dashboardResponse,
    async handler(ctx): Promise<Dashboard> {
      await scorePendingDeals(ctx);
      ctx.invalidateQueries();
      return buildDashboard(ctx);
    },
  }),

  setDealState: defineAction({
    description: "设置某条优惠的已领或收藏状态，刷新抓取不会覆盖。",
    request: z.object({
      id: z.number().int().positive(),
      field: z.enum(["claimed", "favorite"]),
      value: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<z.infer<typeof setDealStateResponse>> {
      const db = ctx.db<typeof schema>();
      const patch =
        args.field === "claimed"
          ? { claimed: args.value ? 1 : 0 }
          : { favorite: args.value ? 1 : 0 };
      await db.update(schema.deals).set(patch).where(eq(schema.deals.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setPushSource: defineAction({
    description: "设置某个来源的优惠是否参与微信推送（不影响抓取与页面展示）。",
    request: z.object({ key: z.string().min(1), enabled: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      if (!SOURCES.some((s) => s.key === args.key)) throw new Error(`未知来源 ${args.key}`);
      const off = await getPushSourcesOff(ctx);
      if (args.enabled) off.delete(args.key);
      else off.add(args.key);
      await setAppSetting(ctx, PUSH_SOURCES_OFF, [...off].join(","));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  getSettings: defineAction({
    description: "读取页面设置的配置状态：只返回是否已配置和末 4 位，永不返回完整密钥。",
    request: z.object({}),
    response: settingsResponse,
    async handler(ctx): Promise<z.infer<typeof settingsResponse>> {
      return readSettings(ctx);
    },
  }),

  saveSettings: defineAction({
    description: "在页面上保存密钥/推送设置。字段不传 = 不改，传空字符串 = 清除。",
    request: z.object({
      xizhiKey: z.string().max(300).optional(),
      openrouterKey: z.string().max(300).optional(),
      jinaKey: z.string().max(300).optional(),
      quietHours: z.string().max(20).optional(),
    }),
    response: settingsResponse,
    async handler(ctx, args): Promise<z.infer<typeof settingsResponse>> {
      // 校验失败不抛异常：托管平台会把异常统一显示成「500」，用户看不到原因。
      // 改为在返回值里带 error，前端直接显示。
      const clean = (v: string) => v.trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
      const writes: [string, string][] = [];
      let error: string | null = null;
      if (args.xizhiKey !== undefined) {
        // 允许直接粘完整推送地址，自动提取 Key
        const v = clean(args.xizhiKey);
        const m = v.match(/(XZ[0-9a-zA-Z]+)/i);
        if (v && !m) error = "息知 Key 格式不对：应为 XZ 开头，或粘贴完整推送地址";
        else writes.push([XIZHI_KEY_SETTING, m?.[1] ?? ""]);
      }
      if (args.openrouterKey !== undefined) {
        const v = clean(args.openrouterKey);
        if (v && !v.startsWith("sk-or-")) error = "OpenRouter Key 格式不对：应为 sk-or- 开头";
        else writes.push(["openrouter_key", v]);
      }
      if (args.jinaKey !== undefined) {
        const v = clean(args.jinaKey);
        if (v && !/^jina_[\w-]+$/.test(v)) error = "Jina Key 格式不对：应为 jina_ 开头";
        else writes.push(["jina_key", v]);
      }
      if (args.quietHours !== undefined) {
        const v = args.quietHours.trim() || "23-8";
        if (v !== "off" && !/^\d{1,2}-\d{1,2}$/.test(v)) error = "静默时段格式：如 23-8，或 off 关闭";
        else writes.push(["push_quiet_hours", v]);
      }
      if (error) return { ...(await readSettings(ctx)), error };
      try {
        for (const [k, v] of writes) await setAppSetting(ctx, k, v);
      } catch (e) {
        console.error("[settings] save failed:", e);
        return { ...(await readSettings(ctx)), error: `保存失败：${e instanceof Error ? e.message : String(e)}` };
      }
      ctx.invalidateQueries();
      return { ...(await readSettings(ctx)), error: null };
    },
  }),

  sendTestPush: defineAction({
    description: "发送一条息知微信测试推送，验证推送链路是否接通；不返回任何密钥信息。",
    request: z.object({}),
    response: testPushResponse,
    async handler(ctx): Promise<z.infer<typeof testPushResponse>> {
      try {
        // 测试推送用与正式推送相同的 Markdown 格式：取当前达标清单前 2 条
        // 拼样例；没有达标条目时用一条固定示例（链接指向 LINUX DO 首页，
        // 真实可用），保证样例里的链接永远点得开。
        const db = ctx.db<typeof schema>();
        const rows = await db
          .select()
          .from(schema.deals)
          .orderBy(desc(schema.deals.firstSeenAt))
          .limit(60);
        const off = await getPushSourcesOff(ctx);
        const candidates: PushCandidate[] = rows
          .filter((d) => !off.has(sourceKeyFromSourceName(d.source)))
          .map((d) => ({
          title: d.title,
          summary: d.summary,
          source: d.source,
          sourceKey: sourceKeyFromSourceName(d.source),
          link: d.link,
          publishedAt: d.publishedAt,
          category: effectiveCategory(d),
          expiresAt: d.expiresAt,
          aiScore: d.aiScore,
        }));
        const { picked } = selectPushDeals(candidates);
        const sampleDeals = picked.slice(0, 2);
        const content =
          sampleDeals.length > 0
            ? `${sampleDeals.map((d, i) => buildPushBlock(d, i + 1)).join("\n\n---\n\n")}\n\n（测试推送：当前达标前 2 条，标题可点击）`
            : "[LINUX DO 福利羊毛 · LINUX DO 首页](https://linux.do/)\n\n（测试推送：当前暂无达标条目，这是固定格式样例，标题可点击）";
        const result = await sendXizhiPush(
          ctx,
          sampleDeals.length > 0 ? `[测试] ${buildPushTitle(sampleDeals)}` : "每日优惠情报 · 测试推送",
          content,
        );
        return {
          ok: result.ok,
          message: result.ok ? "推送成功" : `推送失败：${result.message}`,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[xizhi] test push exception: ${message}`);
        return { ok: false, message: `推送失败：${message}` };
      }
    },
  }),
} satisfies ActionsModule;
