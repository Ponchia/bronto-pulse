-- Generated from src/storage/schema.ts; run npm run schema:generate.
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, provider TEXT NOT NULL, identity TEXT NOT NULL, provider_identity TEXT, config_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS config_versions (hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, config_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, group_id TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','success','failed','skipped')), started_at TEXT NOT NULL, finished_at TEXT, rows_count INTEGER NOT NULL DEFAULT 0, requests_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT, notes_json TEXT NOT NULL DEFAULT '[]', completeness TEXT);
CREATE INDEX IF NOT EXISTS runs_resource_time ON runs(resource_id, group_id, started_at DESC);
CREATE TABLE IF NOT EXISTS observations (run_id TEXT NOT NULL, item_key TEXT NOT NULL, resource_id TEXT NOT NULL, group_id TEXT NOT NULL, partition_day TEXT NOT NULL, metric TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL, timezone TEXT NOT NULL, window_kind TEXT NOT NULL, dimensions_json TEXT NOT NULL, value REAL NOT NULL, numerator REAL, denominator REAL, quality TEXT NOT NULL, methodology TEXT NOT NULL, PRIMARY KEY(run_id,item_key), FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS observations_report ON observations(resource_id,group_id,partition_day,run_id);
CREATE TABLE IF NOT EXISTS partitions (resource_id TEXT NOT NULL, group_id TEXT NOT NULL, day TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(resource_id,group_id,day), FOREIGN KEY(run_id) REFERENCES runs(id));
CREATE TABLE IF NOT EXISTS annotations (id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,date TEXT NOT NULL,title TEXT NOT NULL,url TEXT,kind TEXT NOT NULL CHECK(kind IN ('release','note')));
INSERT OR IGNORE INTO metadata(key,value) VALUES('schema_version','1');
