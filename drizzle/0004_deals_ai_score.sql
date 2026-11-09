ALTER TABLE deals ADD COLUMN ai_score REAL;
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN ai_confidence REAL;
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN ai_scored_at INTEGER;
