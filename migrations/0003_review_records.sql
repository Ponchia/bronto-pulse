-- Generated from src/storage/schema.ts; run npm run schema:generate.
CREATE TABLE IF NOT EXISTS review_records (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,created_at TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS review_records_project_time ON review_records(project_id,created_at DESC,id);
