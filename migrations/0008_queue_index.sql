CREATE INDEX IF NOT EXISTS binance_demo_queued_at ON binance_demo_actions(created_at,id) WHERE state='queued';
