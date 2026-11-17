CREATE TABLE IF NOT EXISTS strategy_versions (
 strategy_id TEXT NOT NULL, version TEXT NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL,
 config TEXT NOT NULL, content_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('DRAFT','VALIDATED','PUBLISHED')),
 revision INTEGER NOT NULL DEFAULT 1, change_note TEXT NOT NULL, source TEXT NOT NULL, parent_version TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER, activated_at INTEGER,
 PRIMARY KEY(strategy_id,version)
);
CREATE TABLE IF NOT EXISTS strategy_active (
 environment TEXT PRIMARY KEY CHECK(environment='BINANCE_DEMO_FUTURES'),
 strategy_id TEXT NOT NULL, version TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0), activated_at INTEGER NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('ACTIVATE','ROLLBACK')),
 FOREIGN KEY(strategy_id,version) REFERENCES strategy_versions(strategy_id,version)
);
CREATE TABLE IF NOT EXISTS strategy_audit (
 id INTEGER PRIMARY KEY, strategy_id TEXT NOT NULL, version TEXT NOT NULL, prior_strategy_id TEXT,
 prior_version TEXT, operation TEXT NOT NULL, actor TEXT NOT NULL, occurred_at INTEGER NOT NULL, detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS strategy_history_key ON strategy_audit(strategy_id,id DESC);
CREATE INDEX IF NOT EXISTS strategy_updated ON strategy_versions(updated_at DESC);
CREATE TRIGGER IF NOT EXISTS strategy_audit_create AFTER INSERT ON strategy_versions BEGIN
 INSERT INTO strategy_audit(strategy_id,version,prior_version,operation,actor,occurred_at,detail)
 VALUES(NEW.strategy_id,NEW.version,NEW.parent_version,'CREATE','administrator',NEW.created_at,NEW.change_note);
END;
CREATE TRIGGER IF NOT EXISTS strategy_published_immutable BEFORE UPDATE ON strategy_versions
WHEN OLD.state='PUBLISHED' AND (NEW.state<>OLD.state OR NEW.revision<>OLD.revision OR NEW.document<>OLD.document OR NEW.config<>OLD.config OR NEW.content_hash<>OLD.content_hash OR NEW.name<>OLD.name OR NEW.change_note<>OLD.change_note)
BEGIN SELECT RAISE(ABORT,'STRATEGY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS strategy_audit_edit AFTER UPDATE OF revision ON strategy_versions BEGIN
 INSERT INTO strategy_audit(strategy_id,version,prior_version,operation,actor,occurred_at,detail)
 VALUES(NEW.strategy_id,NEW.version,NEW.parent_version,
 CASE WHEN OLD.state=NEW.state THEN 'EDIT' ELSE NEW.state END,'administrator',NEW.updated_at,
 CASE WHEN OLD.state=NEW.state THEN json_object('note',NEW.change_note,'revision',NEW.revision,'previousHash',OLD.content_hash,'hash',NEW.content_hash,'previousName',OLD.name,'previousDocument',OLD.document,'previousConfig',json(OLD.config)) ELSE NEW.change_note END);
END;
CREATE TRIGGER IF NOT EXISTS strategy_audit_first_activation AFTER INSERT ON strategy_active BEGIN
 UPDATE strategy_versions SET activated_at=NEW.activated_at WHERE strategy_id=NEW.strategy_id AND version=NEW.version;
 INSERT INTO strategy_audit(strategy_id,version,operation,actor,occurred_at,detail)
 VALUES(NEW.strategy_id,NEW.version,NEW.operation,'administrator',NEW.activated_at,NEW.environment);
END;
CREATE TRIGGER IF NOT EXISTS strategy_audit_switch AFTER UPDATE ON strategy_active BEGIN
 UPDATE strategy_versions SET activated_at=NEW.activated_at WHERE strategy_id=NEW.strategy_id AND version=NEW.version;
 INSERT INTO strategy_audit(strategy_id,version,prior_strategy_id,prior_version,operation,actor,occurred_at,detail)
 VALUES(NEW.strategy_id,NEW.version,OLD.strategy_id,OLD.version,NEW.operation,'administrator',NEW.activated_at,NEW.environment);
END;
CREATE TABLE IF NOT EXISTS strategy_prediction_links (
 prediction_id TEXT PRIMARY KEY REFERENCES pathmatch_predictions(id),
 strategy_id TEXT NOT NULL, version TEXT NOT NULL, content_hash TEXT NOT NULL,
 FOREIGN KEY(strategy_id,version) REFERENCES strategy_versions(strategy_id,version)
);
CREATE INDEX IF NOT EXISTS strategy_prediction_version ON strategy_prediction_links(strategy_id,version);
