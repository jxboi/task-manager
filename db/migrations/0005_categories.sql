-- The runner wraps each file in a transaction so a lock timeout rolls back the migration.
SET LOCAL lock_timeout = '5s';

CREATE TABLE categories (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 48
    AND name !~ '[[:cntrl:]]'
  ),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (user_id, id)
);

CREATE UNIQUE INDEX categories_user_name_idx ON categories (user_id, lower(name));
ALTER TABLE todos ADD COLUMN category_id uuid;
ALTER TABLE todos ADD CONSTRAINT todos_category_fk
  FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id)
  ON DELETE NO ACTION;
CREATE INDEX todos_user_category_idx ON todos (user_id, category_id)
  WHERE category_id IS NOT NULL;
