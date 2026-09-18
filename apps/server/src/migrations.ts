/**
 * Schema migrations, applied automatically at startup in order and recorded in `schema_migrations`.
 * Nobody runs SQL by hand. The design goal is that new funnel versions (new steps, results, events)
 * need NO new migration: everything version-specific lives in `funnel_versions.config_json`.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE funnel_versions (
        funnel_id     TEXT    NOT NULL,
        version       INTEGER NOT NULL,
        config_json   TEXT    NOT NULL,
        config_hash   TEXT    NOT NULL,
        experiment_id TEXT    NOT NULL,
        release_note  TEXT,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (funnel_id, version)
      ) STRICT;

      CREATE TABLE funnel_active (
        funnel_id  TEXT    PRIMARY KEY,
        version    INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (funnel_id, version) REFERENCES funnel_versions (funnel_id, version)
      ) STRICT;

      CREATE TABLE release_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        funnel_id    TEXT    NOT NULL,
        action       TEXT    NOT NULL CHECK (action IN ('publish', 'rollback')),
        from_version INTEGER,
        to_version   INTEGER NOT NULL,
        actor        TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE sessions (
        id             TEXT    PRIMARY KEY,
        funnel_id      TEXT    NOT NULL,
        funnel_version INTEGER NOT NULL,
        experiment_id  TEXT    NOT NULL,
        variant        TEXT    NOT NULL,
        assignment     TEXT    NOT NULL CHECK (assignment IN ('hash', 'override')),
        utm_source     TEXT,
        utm_medium     TEXT,
        utm_campaign   TEXT,
        utm_content    TEXT,
        utm_term       TEXT,
        state_json     TEXT    NOT NULL,
        state_rev      INTEGER NOT NULL DEFAULT 0,
        status         TEXT    NOT NULL CHECK (status IN ('active', 'completed')),
        result_id      TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        FOREIGN KEY (funnel_id, funnel_version) REFERENCES funnel_versions (funnel_id, version)
      ) STRICT;
      CREATE INDEX sessions_by_version ON sessions (funnel_id, funnel_version, variant);

      CREATE TABLE events (
        event_id        TEXT    PRIMARY KEY,
        session_id      TEXT    NOT NULL REFERENCES sessions (id),
        name            TEXT    NOT NULL,
        step_id         TEXT,
        funnel_id       TEXT    NOT NULL,
        funnel_version  INTEGER NOT NULL,
        experiment_id   TEXT    NOT NULL,
        variant         TEXT    NOT NULL,
        assignment      TEXT    NOT NULL,
        utm_source      TEXT,
        utm_medium      TEXT,
        utm_campaign    TEXT,
        client_ts       INTEGER NOT NULL,
        server_ts       INTEGER NOT NULL,
        seq             INTEGER,
        properties_json TEXT    NOT NULL
      ) STRICT;
      CREATE INDEX events_by_version  ON events (funnel_id, funnel_version, variant);
      CREATE INDEX events_by_session  ON events (session_id, seq);
      CREATE INDEX events_by_name     ON events (name);
      CREATE INDEX events_by_campaign ON events (utm_campaign);

      CREATE TABLE ingest_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at INTEGER NOT NULL,
        accepted    INTEGER NOT NULL,
        duplicates  INTEGER NOT NULL,
        rejected    INTEGER NOT NULL,
        reasons     TEXT    NOT NULL
      ) STRICT;
    `,
  },
];
