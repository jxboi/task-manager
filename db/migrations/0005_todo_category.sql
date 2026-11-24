-- One category per task, replacing the tag list in the app. Additive: `tags` stays, and the API
-- keeps it equal to [category] so a deployment still running the tags version keeps working.
-- Rows that version writes during rollout read their category from tags[1] (see todo-endpoint.js).
ALTER TABLE todos ADD COLUMN category text
  CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 24);

UPDATE todos SET category = tags[1] WHERE cardinality(tags) > 0;
