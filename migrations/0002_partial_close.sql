CREATE UNIQUE INDEX IF NOT EXISTS one_active_close_per_position ON trade_actions(position_id) WHERE status IN ('SUBMITTING','PENDING','LIVE','PARTIALLY_FILLED','UNKNOWN');
