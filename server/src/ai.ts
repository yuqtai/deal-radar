// AI 价值评分 + 分类：调用 OpenRouter 的 parallel/decisions 决策模型。
//
// 接口（2026-11-09 实测）：POST https://openrouter.ai/api/alpha/decisions
//   { model, state: {<id>: "<条目文本>", ...}, questions: {<qid>: {...}, ...} }
// - score 题型：criteria 为数组 [低端, 高端]，返回 score ∈ [0,1]，越接近高端越大。
// - choice 题型：criteria 为 {类别名: 说明} 的对象，返回 choice（类别名）与 confidence。
// 该模型不能走 chat/completions。同一请求里每条同时问「价值分」和「类别」，按批发送。
//
// Key 只存服务端 app_settings（openrouter_key），永不下发前端；无 Key 时整体跳过（fail closed）。
// 失败只记日志，不影响抓取与推送（分类退回关键词规则，推送退回关键词打分）。

import type { Ctx } from "@hatch/space-sdk";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import * as schema from "./schema";

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MODEL = "parallel/decisions-fast:free";
const BATCH_SIZE = 8;
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

export async function aiEnabled(ctx: Ctx): Promise<boolean> {
  return (await getSetting(ctx, "openrouter_key")) !== "";
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

async function judgeBatch(key: string, model: string, items: ScoreItem[]): Promise<Map<number, AiResult>> {
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
    const res = await fetch(ENDPOINT, {
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
    const out = new Map<number, AiResult>();
    for (const it of items) {
      const k = `d${it.id}`;
      const r: AiResult = {};
      const sc = data.answers?.[`${k}_score`];
      if (sc && typeof sc.score === "number" && Number.isFinite(sc.score)) {
        r.score = Math.min(1, Math.max(0, sc.score));
        r.confidence = sc.confidence ?? 0;
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
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** 给尚未评分或尚未分类的条目跑一遍 AI（可限定 id），返回成功处理条数。 */
export async function scorePendingDeals(ctx: Ctx, onlyIds?: number[]): Promise<number> {
  const key = await getSetting(ctx, "openrouter_key");
  if (!key) return 0;
  const model = (await getSetting(ctx, "openrouter_model")) || DEFAULT_MODEL;
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
  for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE));

  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      try {
        const result = await judgeBatch(key, model, batch);
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
