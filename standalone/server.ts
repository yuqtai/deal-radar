// 独立运行服务：SQLite + 自动迁移 + POST /actions + 前端页面（Bun HTML bundler + Tailwind）
// + 每 2 小时自动刷新。不依赖任何托管平台，`bun run start` 即可。
//
// 环境变量（均可写在根目录 .env，Bun 会自动加载）：
//   PORT                端口，默认 3000
//   HOST                监听地址，默认 0.0.0.0
//   DATA_DIR            数据目录（SQLite 文件所在），默认 ./data
//   REFRESH_INTERVAL_MINUTES  自动刷新间隔（分钟），默认 120；0 = 关闭
//   XIZHI_KEY           息知微信推送 Key（可选）
//   OPENROUTER_API_KEY  OpenRouter Key，用于 AI 评分/分类/排行榜（可选）
//   OPENROUTER_MODEL    默认 baidu/ernie-5.5-flash-preview:free（免费，失败自动换备用模型）
//   PUSH_QUIET_HOURS    推送静默时段（北京时间），默认 23-8；off = 关闭
//   DECISION_ENDPOINT   决策格式（state + questions）接口地址，默认 OpenRouter /api/alpha/decisions
//   DECISION_MODEL      决策模型，默认 perplexity/pplx-decider-v1.3:free
//   DECISION_API_KEY    决策接口 Key；接口是 OpenRouter 时可不填，复用 OPENROUTER_API_KEY
//   JINA_API_KEY        Jina Reader Key（可选），LINUX DO 被限流（HTTP 429）时配置
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { makeCtx } from "@hatch/space-sdk";
import { Actions } from "../server/src/actions";
import index from "../client/index.html";

const root = join(import.meta.dir, "..");
const dataDir = process.env.DATA_DIR
  ? isAbsolute(process.env.DATA_DIR)
    ? process.env.DATA_DIR
    : join(root, process.env.DATA_DIR)
  : join(root, "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "deals.sqlite");
const sqlite = new Database(dbPath, { create: true });
sqlite.run("PRAGMA journal_mode = WAL");

// ---- 迁移：按文件名顺序执行 drizzle/*.sql，已执行的记在 __migrations ----
sqlite.run("CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY)");
for (const f of readdirSync(join(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort()) {
  if (sqlite.query("SELECT 1 FROM __migrations WHERE name = ?").get(f)) continue;
  sqlite.transaction(() => {
    for (const stmt of readFileSync(join(root, "drizzle", f), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.run(stmt);
    }
    sqlite.run("INSERT INTO __migrations (name) VALUES (?)", [f]);
  })();
  console.log(`[migrate] ${f}`);
}

// ---- 把环境变量里的配置写入 app_settings（服务端只从该表读取，永不下发前端） ----
const putSetting = sqlite.prepare(
  "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const isReal = (v: string | undefined): v is string => !!v && !/^YOUR_/i.test(v.trim());
const configured: string[] = [];
if (isReal(process.env.XIZHI_KEY)) {
  putSetting.run("xizhi_key", process.env.XIZHI_KEY.trim());
  configured.push("微信推送");
}
if (isReal(process.env.OPENROUTER_API_KEY)) {
  putSetting.run("openrouter_key", process.env.OPENROUTER_API_KEY.trim());
  configured.push("AI 评分");
}
if (isReal(process.env.OPENROUTER_MODEL)) putSetting.run("openrouter_model", process.env.OPENROUTER_MODEL.trim());
if (isReal(process.env.DECISION_API_KEY)) {
  putSetting.run("decision_key", process.env.DECISION_API_KEY.trim());
  configured.push("决策模型评分");
}
if (isReal(process.env.DECISION_ENDPOINT)) putSetting.run("decision_endpoint", process.env.DECISION_ENDPOINT.trim());
if (isReal(process.env.DECISION_MODEL)) putSetting.run("decision_model", process.env.DECISION_MODEL.trim());
// Compatibility with the previous Jev-only environment variables.
const legacyJevEnv = isReal(process.env.TYPESAFE_API_KEY) &&
  ![process.env.DECISION_API_KEY, process.env.DECISION_ENDPOINT, process.env.DECISION_MODEL].some(isReal);
if (legacyJevEnv) {
  putSetting.run("decision_key", process.env.TYPESAFE_API_KEY!.trim());
  putSetting.run("decision_endpoint", "https://api.typesafe.ai/v1/systemone");
  putSetting.run("decision_model", isReal(process.env.TYPESAFE_MODEL) ? process.env.TYPESAFE_MODEL.trim() : "jev-latest");
  configured.push("决策模型评分（兼容旧 Jev 配置）");
}
if (isReal(process.env.JINA_API_KEY)) putSetting.run("jina_key", process.env.JINA_API_KEY.trim());
if (isReal(process.env.PUSH_QUIET_HOURS)) putSetting.run("push_quiet_hours", process.env.PUSH_QUIET_HOURS.trim());

// 记下哪些配置来自 .env：页面设置里提示「重启后以 .env 为准」
const envManaged = [
  ["XIZHI_KEY", "xizhi_key"],
  ["OPENROUTER_API_KEY", "openrouter_key"],
  ["DECISION_API_KEY", "decision_key"],
  ["JINA_API_KEY", "jina_key"],
  ["PUSH_QUIET_HOURS", "push_quiet_hours"],
]
  .filter(([env]) => isReal(process.env[env!]))
  .map(([, key]) => key);
if (legacyJevEnv) envManaged.push("decision_key");
putSetting.run("env_managed", envManaged.join(","));

const ctx = makeCtx(sqlite);
type ActionDef = { request: { parse(v: unknown): unknown }; handler: (c: typeof ctx, a: unknown) => Promise<unknown> };
const actions = Actions as unknown as Record<string, ActionDef>;

// ---- 定时刷新（对应 space.json 里的托管定时任务） ----
const intervalMin = Number(process.env.REFRESH_INTERVAL_MINUTES ?? 120);
if (intervalMin > 0) {
  setInterval(() => {
    actions.refreshDeals!.handler(ctx, {}).catch((e) => console.error("[cron] refresh failed:", e));
  }, intervalMin * 60 * 1000);
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "0.0.0.0",
  idleTimeout: 255, // 一轮抓取 + AI 评分可能要几十秒
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/healthz": new Response("ok"),
    "/actions": {
      async POST(req) {
        try {
          const { action, args } = (await req.json()) as { action: string; args: unknown };
          const def = Object.hasOwn(actions, action) ? actions[action] : undefined;
          if (!def) return Response.json({ error: `unknown action ${action}` }, { status: 404 });
          return Response.json(await def.handler(ctx, def.request.parse(args ?? {})));
        } catch (e) {
          console.error(e);
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      },
    },
  },
});

console.log(`
  每日优惠情报 已启动 → http://localhost:${server.port}
  数据库：${dbPath}
  已启用：${configured.length ? configured.join("、") : "基础抓取（未配置推送 / AI，可在页面「设置」或 .env 中添加）"}
  自动刷新：${intervalMin > 0 ? `每 ${intervalMin} 分钟` : "已关闭"}
`);
