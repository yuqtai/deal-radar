// 每日优惠情报的数据表：
// - deals：抓到的优惠条目，按原文链接唯一；claimed/favorite 是用户状态，刷新不覆盖。
// - source_status：每个来源最近一轮的抓取结果（成功/条数/错误原因）。
// - fetch_runs：每一轮抓取的记录，驱动「本轮新增」与统计行。
// - app_settings：服务端设置（键值），存放息知推送 Key、OpenRouter Key 与最近推送结果；只在服务端读写，永不下发前端。

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const deals = sqliteTable("deals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  link: text("link").notNull().unique(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  source: text("source").notNull(),
  category: text("category", {
    enum: ["免费白嫖", "限免", "低价优惠", "会员订阅", "游戏", "AI 相关", "VPS/云服务", "代理/机场", "软件工具", "交易/求购", "讨论/资讯", "其他"],
  }).notNull(),
  publishedAt: integer("published_at"),
  expiresAt: integer("expires_at"),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  claimed: integer("claimed").notNull().default(0),
  favorite: integer("favorite").notNull().default(0),
  // AI 价值评分（OpenRouter parallel/decisions）：0~1，越高越值得领；null = 尚未评分
  aiScore: real("ai_score"),
  aiConfidence: real("ai_confidence"),
  aiScoredAt: integer("ai_scored_at"),
  // AI 分类（choice 题型）；null = 未分类，展示时退回规则分类 category
  aiCategory: text("ai_category"),
  // 成功推送到微信的时间；null = 还没推过（推送失败/静默时段会留到下一轮补推）
  pushedAt: integer("pushed_at"),
});

export const sourceStatus = sqliteTable("source_status", {
  source: text("source").primaryKey(),
  ok: integer("ok").notNull().default(0),
  itemCount: integer("item_count").notNull().default(0),
  error: text("error"),
  fetchedAt: integer("fetched_at"),
});

export const fetchRuns = sqliteTable("fetch_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  newCount: integer("new_count").notNull().default(0),
  totalCount: integer("total_count").notNull().default(0),
  okSources: integer("ok_sources").notNull().default(0),
  totalSources: integer("total_sources").notNull().default(0),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
