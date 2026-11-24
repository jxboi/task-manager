SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Block writers across both statements while allowing plain reads. This mode also avoids
-- upgrading a SHARE lock when the conversion writes to these tables.
LOCK TABLE todos, categories IN SHARE ROW EXCLUSIVE MODE;

-- One-time conversion of tags, which stop being a user concept. A todo's first tag becomes its
-- category; every other tag becomes a "#tag" word at the end of its title. The runner applies
-- this file once, in one transaction. No later migration may create categories from tags:
-- tags an older app writes during rollout are folded into the title by the server instead.

-- A first tag is a category name when its btrim() has 1 to 48 characters and no controls.
-- The explicit ranges match Unicode Cc: C0, DEL and C1. PostgreSQL text cannot contain U+0000.
-- Names that differ only by case share one category with a deterministic spelling. A category the user
-- already created through the API with the same lower(name) is reused.
-- This ignores the API's cap of 50 categories per account: every valid distinct first tag
-- becomes a category, and the API then rejects new categories until the account is below 50.
INSERT INTO categories (user_id, id, name)
SELECT user_id, gen_random_uuid(), min(name COLLATE "C")
FROM (
  SELECT user_id, btrim((SELECT tag FROM unnest(tags) AS u(tag) LIMIT 1)) AS name
  FROM todos WHERE cardinality(tags) > 0
) AS first_tags
WHERE char_length(name) BETWEEN 1 AND 48 AND name !~ U&'[\0001-\001F\007F-\009F]'
GROUP BY user_id, lower(name)
ON CONFLICT (user_id, lower(name)) DO NOTHING;

-- Every tagged todo is relinked, including ones that already had a category: the first tag
-- wins, and an invalid first tag leaves the todo uncategorized. The tags that did not become
-- the category are appended as " #tag" in array order, NULL elements skipped, whole tags only
-- while the title stays within 2,000 characters. Tags after the first one that does not fit
-- are dropped; that is the only data this conversion loses. The title itself is never cut.
WITH links AS (
  SELECT t.user_id, t.id, c.id AS category_id
  FROM todos t
  CROSS JOIN LATERAL (
    SELECT btrim(tag) AS name FROM unnest(t.tags) AS u(tag) LIMIT 1
  ) AS first_tag
  LEFT JOIN categories c ON c.user_id = t.user_id
    AND char_length(first_tag.name) BETWEEN 1 AND 48 AND first_tag.name !~ U&'[\0001-\001F\007F-\009F]'
    AND lower(c.name) = lower(first_tag.name)
)
UPDATE todos t
SET category_id = links.category_id,
  text = t.text || COALESCE((
    SELECT string_agg(' #' || tag, '' ORDER BY n)
    FROM (
      SELECT tag, n, sum(char_length(tag) + 2) OVER (ORDER BY n) AS added
      FROM unnest(t.tags) WITH ORDINALITY AS u(tag, n)
      WHERE tag IS NOT NULL AND (n > 1 OR links.category_id IS NULL)
    ) AS folded
    WHERE char_length(t.text) + added <= 2000
  ), ''),
  tags = '{}',
  revision = t.revision + 1
FROM links
WHERE t.user_id = links.user_id AND t.id = links.id;
