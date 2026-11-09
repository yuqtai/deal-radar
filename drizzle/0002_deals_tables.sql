DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  published_at INTEGER,
  expires_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE source_status (
  source TEXT PRIMARY KEY,
  ok INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  fetched_at INTEGER
);
--> statement-breakpoint
CREATE TABLE fetch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  new_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  ok_sources INTEGER NOT NULL DEFAULT 0,
  total_sources INTEGER NOT NULL DEFAULT 0
);
