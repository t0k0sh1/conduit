CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

INSERT INTO teams (name)
VALUES ('Alpha'), ('Beta');

INSERT INTO members (team_id, name)
VALUES
  (1, 'Alice'),
  (1, 'Bob'),
  (2, 'Carol');
