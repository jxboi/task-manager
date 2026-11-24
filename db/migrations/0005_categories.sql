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

-- Install the indexes and FK first so the backfill uses the same uniqueness
-- and ownership checks as later writes. The partial index starts empty.
CREATE UNIQUE INDEX categories_user_name_idx ON categories (user_id, lower(name));
ALTER TABLE todos ADD COLUMN category_id uuid;
ALTER TABLE todos ADD CONSTRAINT todos_category_fk
  FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id)
  ON DELETE NO ACTION;
CREATE INDEX todos_user_category_idx ON todos (user_id, category_id)
  WHERE category_id IS NOT NULL;

-- BACKFILL
-- Only the first tag is eligible. Skip invalid names and consistently choose
-- one stored spelling when several first tags differ only by case.
WITH first_tags AS (
  SELECT user_id, tags[1] AS tag FROM todos
  WHERE category_id IS NULL AND cardinality(tags) > 0
)
INSERT INTO categories (user_id, id, name)
SELECT user_id, gen_random_uuid(), min(tag COLLATE "C")
FROM first_tags
WHERE tag IS NOT NULL AND tag = btrim(tag) AND char_length(tag) BETWEEN 1 AND 48
  AND tag !~ '[[:cntrl:]]'
GROUP BY user_id, lower(tag)
ON CONFLICT (user_id, lower(name)) DO NOTHING;

-- Preserve existing assignments and all fields used by the tag-based app.
UPDATE todos SET category_id = c.id
FROM categories c
WHERE todos.category_id IS NULL AND cardinality(todos.tags) > 0
  AND c.user_id = todos.user_id AND lower(c.name) = lower(todos.tags[1]);
