CREATE TABLE IF NOT EXISTS virtual_accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  initial TEXT NOT NULL, wallet TEXT NOT NULL, realized TEXT NOT NULL, fees TEXT NOT NULL,
  peak TEXT NOT NULL, drawdown TEXT NOT NULL,
  fee_bps INTEGER NOT NULL, slip_bps INTEGER NOT NULL, deviation_bps INTEGER NOT NULL
);
INSERT OR IGNORE INTO virtual_accounts VALUES ('main','默认实验账户',0,'80','80','0','0','80','0',5,2,50);
CREATE TABLE IF NOT EXISTS virtual_positions (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES virtual_accounts(id), symbol TEXT NOT NULL,
  opened_at INTEGER NOT NULL, closed_at INTEGER, cursor INTEGER NOT NULL, shadow_of TEXT,
  net_sign INTEGER NOT NULL CHECK(net_sign IN (-1,0,1)), data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS virtual_active ON virtual_positions(symbol,cursor) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS virtual_history ON virtual_positions(account_id,closed_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS virtual_events (
  id TEXT PRIMARY KEY, position_id TEXT NOT NULL REFERENCES virtual_positions(id),
  account_id TEXT NOT NULL REFERENCES virtual_accounts(id), occurred_at INTEGER NOT NULL, kind TEXT NOT NULL,
  shadow INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS virtual_events_position ON virtual_events(position_id,occurred_at,id);
CREATE INDEX IF NOT EXISTS virtual_events_account ON virtual_events(account_id,shadow,occurred_at);
CREATE TABLE IF NOT EXISTS virtual_requests (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, intent TEXT NOT NULL, created_at INTEGER NOT NULL, result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS virtual_mutex (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS virtual_guard (ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE IF NOT EXISTS virtual_market (symbol TEXT PRIMARY KEY, price TEXT, time INTEGER, error TEXT, checked_at INTEGER NOT NULL);
