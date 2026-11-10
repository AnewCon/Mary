CREATE TABLE IF NOT EXISTS trade_plans(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,actor TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS trade_plans_created ON trade_plans(created_at DESC,id DESC);
