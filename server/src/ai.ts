// AI 价值评分 + 分类，支持两种通用格式，接口地址 / Key / 模型都可自定义：
//
// 1) 决策格式（System One，优先）：
//    POST <决策接口> { model, state: {<id>: "<帖子>"}, questions: {<id>: {type, instructions, criteria}} }
//    → { answers: {<id>: {score | choice, confidence, probabilities}} }
//    - score 题：criteria 为 [低端, 高端]，返回 score ∈ [0, 档位数-1]，归一化到 0~1
//    - choice 题：criteria 为 {类别: 说明}，返回 choice 与 confidence
//    兼容 OpenRouter 决策接口（/api/alpha/decisions，默认免费模型 perplexity/pplx-decider-v1.3:free）、
//    TypeSafe Jev（https://api.typesafe.ai/v1/systemone）等同格式服务。
// 2) 对话格式（兜底）：OpenRouter 免费对话模型 chat/completions，一次请求批量返回 JSON；
//    主模型失败时依次尝试 FALLBACK_CHAT_MODELS。决策格式失败或未配置时使用。
//
// Key 只存服务端 app_settings，永不下发前端；无 Key 时整体跳过（fail closed）。
// 失败只记日志，不影响抓取与推送（分类退回关键词规则，推送退回关键词打分）。

import type { Ctx } from "@hatch/space-sdk";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import * as schema from "./schema";

export const DEFAULT_DECISION_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_DECISION_MODEL = "perplexity/pplx-decider-v1.3:free";
const CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_CHAT_MODEL = "baidu/ernie-5.5-flash-preview:free";
/** 免费模型随时可能限流或下线，主模型失败时按顺序换下一个 */
const FALLBACK_CHAT_MODELS = [
  "baidu/ernie-5.5-flash-preview:free",
  "inclusionai/ling-3.2-flash:free",
  "nvidia/nemotron-3.5-lightning:free",
];
/** 已下线的免费模型：配置里还写着它时当作没配置 */
const RETIRED_MODELS = new Set(["parallel/decisions-fast:free"]);
const BATCH_SIZE = 8;
/** 对话模型一次多评几条，省请求数（免费额度按请求数计） */
const CHAT_BATCH_SIZE = 15;
const CONCURRENCY = 3;
const MAX_PER_RUN = 200;
const TIMEOUT_MS = 40_000;
/** 分类置信度低于此值时不采用 AI 分类，退回规则分类 */
const MIN_CATEGORY_CONFIDENCE = 0.35;

const SCORE_CRITERIA = [
  {
    name: "low",
    description:
      "价值很低：求购/出售/转让/讨论/晒单帖、到手价值很小、门槛高（需大额消费、拉人头、特定地区或特定银行卡）、普通人难以参与、疑似引流或已失效",
  },
  {
    name: "high",
    description:
      "价值很高：真金白银、话费/红包/现金返还、游戏或软件永久免费入库、会员免费领、到手价值大、门槛低、大多数人现在就能参与",
  },
];

/** AI 分类体系（顺序即页面筛选按钮顺序，前端 CATEGORIES 保持一致） */
export const AI_CATEGORIES: Record<string, string> = {
  免费白嫖: "可以直接免费领到的东西：话费、红包、现金、实物、积分、免费额度、抽奖",
  限免: "平时收费、限时免费领取或免费使用的软件、游戏、课程、服务",
  低价优惠: "打折、优惠券、优惠码、特价、返现等花钱但比平时便宜的购物优惠（不含 VPS 与代理）",
  会员订阅: "视频/音乐/网盘/App 会员、VIP、订阅类权益的免费领取或优惠",
  游戏: "游戏相关：Steam/Epic 喜加一、游戏折扣、游戏礼包",
  "AI 相关": "AI 产品与模型：ChatGPT、Claude、Gemini 等的额度、账号、API 福利或活动（AI 中转/代充推广也算）",
  "VPS/云服务": "商家的 VPS、服务器、云主机、域名、CDN、建站相关售卖或优惠",
  "代理/机场": "代理 IP、住宅 IP、机场、VPN、加速器的推广或优惠",
  软件工具: "软件、App、开源工具的发布、更新或介绍，不是优惠活动",
  其他: "不属于上述任何类别的内容",
  "交易/求购": "个人出售、收购、转让、求购、拼车帖（标题常见 出 / 收 / 求 / 转）",
  "讨论/资讯": "提问、求推荐、闲聊讨论、新闻资讯、安全通告，不是优惠",
};

async function getSetting(ctx: Ctx, key: string): Promise<string> {
  try {
    const db = ctx.db<typeof schema>();
    const rows = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key));
    return rows[0]?.value?.trim() ?? "";
  } catch {
    return "";
  }
}

interface AiConfig {
  /** 决策格式：接口、Key、模型；Key 为空表示不用决策格式 */
  decision: { endpoint: string; key: string; model: string } | null;
  /** 对话格式兜底（OpenRouter）：Key 为空表示不用 */
  chat: { key: string; model: string } | null;
}

/**
 * 读取 AI 配置：
 * - decision_endpoint / decision_model 默认 OpenRouter 决策接口 + 免费 pplx-decider；
 * - decision_key 不填时，若决策接口是 OpenRouter 就复用 openrouter_key。
 */
export async function getAiConfig(ctx: Ctx): Promise<AiConfig> {
  const orKey = await getSetting(ctx, "openrouter_key");
  const endpoint = (await getSetting(ctx, "decision_endpoint")) || DEFAULT_DECISION_ENDPOINT;
  const decisionModel = (await getSetting(ctx, "decision_model")) || DEFAULT_DECISION_MODEL;
  const decisionKey =
    (await getSetting(ctx, "decision_key")) || (endpoint.startsWith("https://openrouter.ai/") ? orKey : "");
  const chatConfigured = await getSetting(ctx, "openrouter_model");
  // 旧配置里的模型名：决策模型或已下线的，都不当作对话模型
  const chatModel =
    chatConfigured && !RETIRED_MODELS.has(chatConfigured) && !/decision|decider|jev/i.test(chatConfigured)
      ? chatConfigured
      : DEFAULT_CHAT_MODEL;
  return {
    decision: decisionKey ? { endpoint, key: decisionKey, model: decisionModel } : null,
    chat: orKey ? { key: orKey, model: chatModel } : null,
  };
}

export async function aiEnabled(ctx: Ctx): Promise<boolean> {
  const cfg = await getAiConfig(ctx);
  return cfg.decision != null || cfg.chat != null;
}

/** 测试 AI：用一条固定样例真实调用一次，决策格式和对话格式配了哪个测哪个 */
export async function testAiConnection(ctx: Ctx): Promise<{ ok: boolean; message: string }> {
  const cfg = await getAiConfig(ctx);
  const sample: ScoreItem = { id: 1, title: "中国移动免费领 30G 流量，限时三天", summary: "", source: "测试" };
  const show = (r: AiResult | undefined) =>
    `样例得分 ${r?.score != null ? Math.min(100, Math.round((r.score / 0.5) * 100)) : "—"}，分类「${r?.category ?? "—"}」`;
  const lines: string[] = [];
  let ok = false;
  if (cfg.decision) {
    try {
      lines.push(`决策模型正常（${cfg.decision.model}）：${show((await judgeDecision(cfg.decision, [sample])).get(1))}`);
      ok = true;
    } catch (e) {
      lines.push(`决策模型失败（${cfg.decision.model}）：${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }
  if (cfg.chat) {
    try {
      lines.push(`兜底对话模型正常：${show((await judgeChatWithFallback(cfg.chat, [sample])).get(1))}`);
      ok = true;
    } catch (e) {
      lines.push(`兜底对话模型失败：${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }
  if (lines.length === 0) return { ok: false, message: "还没配置 AI：填写决策模型 Key 或 OpenRouter Key" };
  return { ok, message: lines.join("；") };
}

interface ScoreItem {
  id: number;
  title: string;
  summary: string;
  source: string;
}

interface AiResult {
  score?: number;
  confidence?: number;
  category?: string;
}

// 对话模型打 0~100 分；存库时除以 200，与决策模型的分布对齐（其 ≥0.4 已是头部）：
// 展示分 = 存储分 / 0.5 × 100，所以 100 分对应满分，推送门槛 0.3 对应 60 分。
const CHAT_SCORE_DIVISOR = 200;

function buildChatPrompt(items: ScoreItem[]): string {
  const cats = Object.entries(AI_CATEGORIES)
    .map(([k, v]) => `- ${k}：${v}`)
    .join("\n");
  const list = items
    .map((it, i) => `${i + 1}. 【${it.source}】${it.title}${it.summary ? `；${it.summary.slice(0, 160)}` : ""}`)
    .join("\n");
  return `你是羊毛/优惠情报评审。对下面每条帖子：
1) 打「对普通中国用户的实际价值」分，0-100 的整数。
   高分：${SCORE_CRITERIA[1]!.description}
   低分：${SCORE_CRITERIA[0]!.description}
2) 从下列类别中选一个最贴切的（以标题为主，简介为辅），都不合适就填「其他」：
${cats}

只输出 JSON，不要任何解释：{"items":[{"i":序号,"score":整数,"category":"类别名"}]}

${list}`;
}

async function judgeChat(key: string, model: string, items: ScoreItem[]): Promise<Map<number, AiResult>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: buildChatPrompt(items) }],
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    const json = content.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error(`模型没有返回 JSON：${content.slice(0, 120)}`);
    const parsed = JSON.parse(json) as { items?: { i?: number; score?: number; category?: string }[] };
    const out = new Map<number, AiResult>();
    for (const row of parsed.items ?? []) {
      const it = typeof row.i === "number" ? items[row.i - 1] : undefined;
      if (!it) continue;
      const r: AiResult = {};
      if (typeof row.score === "number" && Number.isFinite(row.score)) {
        r.score = Math.min(100, Math.max(0, row.score)) / CHAT_SCORE_DIVISOR;
        r.confidence = 1;
      }
      const cat = row.category?.trim();
      if (cat && cat in AI_CATEGORIES) r.category = cat;
      if (r.score != null || r.category != null) out.set(it.id, r);
    }
    if (out.size === 0) throw new Error("模型返回的 JSON 里没有可用结果");
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** 对话模型：先用配置的模型，失败再按备选列表依次尝试 */
async function judgeChatWithFallback(
  chat: { key: string; model: string },
  items: ScoreItem[],
): Promise<Map<number, AiResult>> {
  const chain = [chat.model, ...FALLBACK_CHAT_MODELS.filter((m) => m !== chat.model)];
  let lastErr: unknown;
  for (const m of chain) {
    try {
      return await judgeChat(chat.key, m, items);
    } catch (e) {
      lastErr = e;
      console.error(`[ai] ${m} failed: ${e instanceof Error ? e.message : String(e)}`);
      // Key 无效时换模型也没用
      if (e instanceof Error && /^HTTP 401/.test(e.message)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// 决策模型的原始分 0~1 分布较开（好帖 ~0.8、交易帖 ~0.35），存库时 ÷2：
// 展示分 = 存储分 / 0.5 × 100 = 原始分 × 100，推送门槛 0.3 对应原始分 0.6。
const DECISION_SCORE_DIVISOR = 2;

/** 决策格式（System One）：每条帖子同时问「价值分」和「类别」 */
async function judgeDecision(
  d: { endpoint: string; key: string; model: string },
  items: ScoreItem[],
): Promise<Map<number, AiResult>> {
  const { endpoint, key, model } = d;
  const state: Record<string, string> = {};
  const questions: Record<string, unknown> = {};
  for (const it of items) {
    const k = `d${it.id}`;
    state[k] = `【${it.source}】${it.title}${it.summary ? `；${it.summary.slice(0, 160)}` : ""}`;
    questions[`${k}_score`] = {
      type: "score",
      instructions: `只评估 state 中键为 ${k} 的那条羊毛/优惠，对普通中国用户的实际价值`,
      criteria: SCORE_CRITERIA,
    };
    questions[`${k}_cat`] = {
      type: "choice",
      instructions: `判断 state 中键为 ${k} 的帖子属于哪一类（以标题为主，简介为辅）`,
      criteria: AI_CATEGORIES,
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state, questions }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    const data = JSON.parse(text) as {
      answers?: Record<string, { score?: number; confidence?: number; choice?: string }>;
    };
    if (!data?.answers || typeof data.answers !== "object" || Array.isArray(data.answers)) {
      throw new Error("返回里没有有效的 answers，接口可能不是决策格式");
    }
    const out = new Map<number, AiResult>();
    for (const it of items) {
      const k = `d${it.id}`;
      const r: AiResult = {};
      const sc = data.answers?.[`${k}_score`];
      if (sc && typeof sc.score === "number" && Number.isFinite(sc.score)) {
        // score 是档位数轴上的位置（0 ~ 档位数-1）；这里两档，归一化后即 0~1
        r.score = Math.min(1, Math.max(0, sc.score / (SCORE_CRITERIA.length - 1))) / DECISION_SCORE_DIVISOR;
        r.confidence = typeof sc.confidence === "number" && Number.isFinite(sc.confidence)
          ? Math.min(1, Math.max(0, sc.confidence)) : 0;
      }
      const cat = data.answers?.[`${k}_cat`];
      if (
        cat?.choice &&
        cat.choice in AI_CATEGORIES &&
        (cat.confidence ?? 0) >= MIN_CATEGORY_CONFIDENCE
      ) {
        r.category = cat.choice;
      }
      if (r.score != null || r.category != null) out.set(it.id, r);
    }
    if (![...out.values()].some((r) => r.score != null)) {
      throw new Error("决策接口没有返回可用评分");
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** 给尚未评分或尚未分类的条目跑一遍 AI（可限定 id），返回成功处理条数。 */
export async function scorePendingDeals(ctx: Ctx, onlyIds?: number[]): Promise<number> {
  const cfg = await getAiConfig(ctx);
  if (!cfg.decision && !cfg.chat) return 0;
  const batchSize = cfg.decision ? BATCH_SIZE : CHAT_BATCH_SIZE;
  // 决策格式优先；失败且配了 OpenRouter 时退回对话格式
  const judge = async (batch: ScoreItem[]): Promise<Map<number, AiResult>> => {
    if (cfg.decision) {
      try {
        return await judgeDecision(cfg.decision, batch);
      } catch (e) {
        if (!cfg.chat) throw e;
        console.error(`[ai] decision model failed, fallback to chat: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return judgeChatWithFallback(cfg.chat!, batch);
  };
  const db = ctx.db<typeof schema>();
  const pending = or(isNull(schema.deals.aiScore), isNull(schema.deals.aiCategory));
  const where = onlyIds && onlyIds.length > 0 ? and(pending, inArray(schema.deals.id, onlyIds)) : pending;
  const rows = await db
    .select({
      id: schema.deals.id,
      title: schema.deals.title,
      summary: schema.deals.summary,
      source: schema.deals.source,
    })
    .from(schema.deals)
    .where(where)
    .limit(MAX_PER_RUN);
  if (rows.length === 0) return 0;

  const batches: ScoreItem[][] = [];
  for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize));

  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      try {
        const result = await judge(batch);
        const now = Date.now();
        for (const [id, r] of result) {
          await db
            .update(schema.deals)
            .set({
              ...(r.score != null ? { aiScore: r.score, aiConfidence: r.confidence ?? 0, aiScoredAt: now } : {}),
              // 低置信度时记为 "其他" 占位，避免每轮重复请求；展示时 "其他" 会退回规则分类
              aiCategory: r.category ?? "其他",
            })
            .where(eq(schema.deals.id, id));
          done++;
        }
      } catch (e) {
        console.error(`[ai] batch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  console.log(`[ai] judged ${done}/${rows.length}`);
  return done;
}
