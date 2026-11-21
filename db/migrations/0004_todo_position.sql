ALTER TABLE todos ADD COLUMN position text COLLATE "C"
  CHECK (position ~ '^[0-9]{20}[0-9a-f]*[1-9a-f]$');

-- Fill the same key on read for inserts made by an older app during rollout.
-- The offset makes the entire bigint timestamp range sort as unsigned decimal text.
CREATE FUNCTION todo_initial_position(created_at bigint, id uuid)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT lpad((created_at::numeric + 9223372036854775808)::text, 20, '0')
    || '8' || replace(id::text, '-', '') || '8'
$$;

UPDATE todos SET position = todo_initial_position(created_at, id);
