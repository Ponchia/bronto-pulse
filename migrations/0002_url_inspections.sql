-- Generated from src/storage/schema.ts; run npm run schema:generate.
CREATE TABLE IF NOT EXISTS url_inspections (id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,url TEXT NOT NULL,inspected_at TEXT NOT NULL,result_json TEXT NOT NULL,FOREIGN KEY(resource_id) REFERENCES resources(id));
