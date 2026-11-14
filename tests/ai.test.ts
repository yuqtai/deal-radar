import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { makeCtx } from "../standalone/space-sdk/server";
import { Actions } from "../server/src/actions";
import { getAiConfig, scorePendingDeals, testAiConnection } from "../server/src/ai";

const originalFetch = globalThis.fetch;
const databases: Database[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const db of databases.splice(0)) db.close();
});

function fixture(settings: Record<string, string> = {}, legacy = false) {
  const db = new Database(":memory:");
  databases.push(db);
  const migrations = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort();
  for (const f of migrations.filter((f) => !f.startsWith("0007"))) {
    db.exec(readFileSync(`drizzle/${f}`, "utf8"));
  }
  for (const [key, value] of Object.entries(settings)) {
    db.run("INSERT INTO app_settings (key, value) VALUES (?, ?)", [key, value]);
  }
  if (legacy) db.exec(readFileSync("drizzle/0007_generic_decision_settings.sql", "utf8"));
  return { db, ctx: makeCtx(db) };
}

describe("generic System One decisions", () => {
  test("saves custom settings without returning the key and clears back to defaults", async () => {
    const { ctx } = fixture();
    const result = await Actions.saveSettings.handler(ctx, {
      decisionKey: "Bearer custom-secret-key",
      decisionEndpoint: "https://decisions.example/v1/systemone/",
      decisionModel: "custom-decision-model",
    });
    expect(result.error).toBeNull();
    expect(result.decision.set).toBe(true);
    expect(JSON.stringify(result)).not.toContain("custom-secret-key");
    expect((await getAiConfig(ctx)).decision).toEqual({
      key: "custom-secret-key", endpoint: "https://decisions.example/v1/systemone", model: "custom-decision-model",
    });
    const invalid = await Actions.saveSettings.handler(ctx, { decisionEndpoint: "https://", decisionModel: "not-saved" });
    expect(invalid.error).toBeTruthy();
    expect(invalid.decisionModel).toBe("custom-decision-model");
    await Actions.saveSettings.handler(ctx, { decisionKey: "", decisionEndpoint: "", decisionModel: "" });
    expect((await getAiConfig(ctx)).decision).toBeNull();
  });

  test("reuses OpenRouter keys only for OpenRouter endpoints", async () => {
    const { ctx } = fixture({ openrouter_key: "sk-or-test-key" });
    expect((await getAiConfig(ctx)).decision?.model).toBe("perplexity/pplx-decider-v1.3:free");
    await Actions.saveSettings.handler(ctx, { decisionEndpoint: "https://other.example/decisions" });
    expect((await getAiConfig(ctx)).decision).toBeNull();
  });

  test("migrates existing Jev settings without overwriting explicit generic settings", async () => {
    const { ctx, db } = fixture({ typesafe_key: "legacy-secret-key", typesafe_model: "jev-custom" }, true);
    expect((await getAiConfig(ctx)).decision).toEqual({
      endpoint: "https://api.typesafe.ai/v1/systemone", key: "legacy-secret-key", model: "jev-custom",
    });
    await Actions.saveSettings.handler(ctx, { decisionKey: "" });
    db.exec(readFileSync("drizzle/0007_generic_decision_settings.sql", "utf8"));
    expect((await getAiConfig(ctx)).decision).toBeNull();
    const custom = fixture({ typesafe_key: "legacy-secret-key", decision_endpoint: "https://other.example/api" }, true);
    expect((await getAiConfig(custom.ctx)).decision).toBeNull();
  });

  test("sends state and questions to the custom endpoint and stores scores on the display scale", async () => {
    const { ctx, db } = fixture({ decision_key: "custom-secret-key", decision_endpoint: "https://other.example/api", decision_model: "custom" });
    db.run("INSERT INTO deals (id, link, title, source, category, first_seen_at, last_seen_at) VALUES (1, 'https://deal.example', '免费领流量', '测试', '其他', 1, 1)");
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://other.example/api");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer custom-secret-key");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("custom");
      expect(body.state.d1).toContain("免费领流量");
      expect(body.questions.d1_score.type).toBe("score");
      expect(body.questions.d1_cat.type).toBe("choice");
      expect(body.messages).toBeUndefined();
      return Response.json({ answers: { d1_score: { score: 0.8, confidence: 0.9 }, d1_cat: { choice: "免费白嫖", confidence: 0.9 } } });
    }) as typeof fetch;
    expect(await scorePendingDeals(ctx, [1])).toBe(1);
    expect(db.query("SELECT ai_score, ai_category FROM deals WHERE id = 1").get()).toEqual({ ai_score: 0.4, ai_category: "免费白嫖" });
  });

  test("empty decision results fail the connection test", async () => {
    const { ctx } = fixture({ decision_key: "custom-secret-key" });
    globalThis.fetch = (async () => Response.json({ answers: {} })) as typeof fetch;
    const result = await testAiConnection(ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("没有返回可用评分");
  });

  test("falls back to chat when the decision endpoint fails or returns unusable results", async () => {
    for (const response of [Response.json({ error: "unavailable" }, { status: 503 }), Response.json({ answers: {} })]) {
      const { ctx, db } = fixture({ openrouter_key: "sk-or-test-key" });
      db.run("INSERT INTO deals (id, link, title, source, category, first_seen_at, last_seen_at) VALUES (1, 'https://deal.example', '免费领流量', '测试', '其他', 1, 1)");
      const calls: string[] = [];
      globalThis.fetch = (async (url) => {
        calls.push(String(url));
        return String(url).endsWith("/decisions") ? response : Response.json({ choices: [{ message: { content: '{"items":[{"i":1,"score":70,"category":"免费白嫖"}]}' } }] });
      }) as typeof fetch;
      expect(await scorePendingDeals(ctx)).toBe(1);
      expect(calls.map((u) => new URL(u).pathname)).toEqual(["/api/alpha/decisions", "/api/v1/chat/completions"]);
      expect(db.query("SELECT ai_score FROM deals").get()).toEqual({ ai_score: 0.35 });
    }
  });
});
