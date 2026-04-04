CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO teams (name)
VALUES ('Alpha'), ('Beta');

INSERT INTO members (team_id, name)
VALUES
  (1, 'Alice'),
  (1, 'Bob'),
  (2, 'Carol');

INSERT INTO projects (name, status)
VALUES ('Website', 'open'), ('Mobile app', 'paused');

INSERT INTO settings (key, value)
VALUES ('theme', 'light'), ('locale', 'en');

-- Wide table for UI horizontal-scroll demos (many columns).
CREATE TABLE wide_demo (
  id SERIAL PRIMARY KEY,
  col_01 TEXT,
  col_02 TEXT,
  col_03 TEXT,
  col_04 TEXT,
  col_05 TEXT,
  col_06 TEXT,
  col_07 TEXT,
  col_08 TEXT,
  col_09 TEXT,
  col_10 TEXT,
  col_11 TEXT,
  col_12 TEXT,
  col_13 TEXT,
  col_14 TEXT,
  col_15 TEXT,
  col_16 TEXT,
  col_17 TEXT,
  col_18 TEXT,
  col_19 TEXT,
  col_20 TEXT,
  col_21 TEXT,
  col_22 TEXT,
  col_23 TEXT,
  col_24 TEXT
);

-- Enough rows for vertical scroll in the table preview (limit 100 in the app).
INSERT INTO wide_demo (
  col_01, col_02, col_03, col_04, col_05, col_06, col_07, col_08,
  col_09, col_10, col_11, col_12, col_13, col_14, col_15, col_16,
  col_17, col_18, col_19, col_20, col_21, col_22, col_23, col_24
)
SELECT
  'r' || g || 'c01', 'r' || g || 'c02', 'r' || g || 'c03', 'r' || g || 'c04',
  'r' || g || 'c05', 'r' || g || 'c06', 'r' || g || 'c07', 'r' || g || 'c08',
  'r' || g || 'c09', 'r' || g || 'c10', 'r' || g || 'c11', 'r' || g || 'c12',
  'r' || g || 'c13', 'r' || g || 'c14', 'r' || g || 'c15', 'r' || g || 'c16',
  'r' || g || 'c17', 'r' || g || 'c18', 'r' || g || 'c19', 'r' || g || 'c20',
  'r' || g || 'c21', 'r' || g || 'c22', 'r' || g || 'c23', 'r' || g || 'c24'
FROM generate_series(1, 100) AS g;

CREATE SCHEMA app_data;

CREATE TABLE app_data.documents (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL
);

CREATE TABLE app_data.attachments (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES app_data.documents (id) ON DELETE CASCADE,
  path TEXT NOT NULL
);

INSERT INTO app_data.documents (title)
VALUES ('Spec'), ('Notes');

INSERT INTO app_data.attachments (document_id, path)
VALUES
  (1, '/files/spec.pdf'),
  (2, '/files/notes.txt');

CREATE SCHEMA analytics;

CREATE TABLE analytics.events (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE analytics.daily_rollups (
  day DATE PRIMARY KEY,
  event_count INTEGER NOT NULL
);

INSERT INTO analytics.events (name)
VALUES ('page_view'), ('click');

INSERT INTO analytics.daily_rollups (day, event_count)
VALUES ('2026-04-01', 42), ('2026-04-02', 17);
