CREATE TABLE IF NOT EXISTS pulsescan_records (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pulsescan_records_table_updated
  ON pulsescan_records (table_name, updated_at DESC);
