CREATE TABLE IF NOT EXISTS binance_demo_actions (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
