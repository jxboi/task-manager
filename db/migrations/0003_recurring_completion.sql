ALTER TABLE todos ADD COLUMN completed_until bigint
  CHECK (completed_until IS NULL OR (completed AND completed_until BETWEEN -8640000000000000 AND 8640000000000000));
