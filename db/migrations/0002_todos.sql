CREATE TABLE todos (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  text text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 2000),
  completed boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  due bigint CHECK (due BETWEEN -8640000000000000 AND 8640000000000000),
  repeat text NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly')),
  notified bigint,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (user_id, id),
  CHECK (due IS NOT NULL OR (repeat = 'none' AND notified IS NULL)),
  CHECK (notified IS NULL OR notified = due)
);
CREATE INDEX todos_user_created_idx ON todos (user_id, created_at, id);
