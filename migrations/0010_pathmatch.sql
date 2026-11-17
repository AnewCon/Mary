CREATE TABLE IF NOT EXISTS pathmatch_predictions (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  symbol TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  locked_at INTEGER,
  start_at INTEGER,
  atr REAL,
  last_check INTEGER,
  result TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pathmatch_active ON pathmatch_predictions(state,expires_at);
CREATE INDEX IF NOT EXISTS pathmatch_history ON pathmatch_predictions(symbol,created_at DESC);
