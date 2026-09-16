CREATE TABLE IF NOT EXISTS pulsescan_records (id TEXT PRIMARY KEY, table_name TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pulsescan_records_table ON pulsescan_records(table_name, updated_at DESC);
