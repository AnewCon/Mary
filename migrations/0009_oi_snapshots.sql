CREATE TABLE IF NOT EXISTS oi_snapshots (
    id INTEGER PRIMARY KEY,
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL,
    open_interest TEXT NOT NULL,
    open_interest_value TEXT,
    mark_price TEXT,
    source_timestamp INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    sample_slot INTEGER NOT NULL,
    UNIQUE(exchange, symbol, source_timestamp),
    UNIQUE(exchange, symbol, sample_slot)
);
CREATE INDEX IF NOT EXISTS oi_snapshots_retention ON oi_snapshots(source_timestamp);
