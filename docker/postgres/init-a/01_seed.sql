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
