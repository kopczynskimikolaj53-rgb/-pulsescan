import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
});

function convertPlaceholders(sql: string) {
  let index = 0;

  return sql.replace(/\?/g, () => {
    index++;
    return `$${index}`;
  });
}

function normalizeRows(rows: any[]) {
  return rows.map((row) => {
    if (
      row &&
      row.data !== undefined &&
      typeof row.data !== "string"
    ) {
      return {
        ...row,
        data: JSON.stringify(row.data),
      };
    }

    return row;
  });
}

function makeStatement(sql: string) {
  let values: unknown[] = [];
  const postgresSql = convertPlaceholders(sql);

  return {
    bind(...args: unknown[]) {
      values = args;
      return this;
    },

    async all<T = any>() {
      const result = await pool.query(postgresSql, values);

      return {
        results: normalizeRows(result.rows) as T[],
      };
    },

    async first<T = any>() {
      const result = await pool.query(postgresSql, values);
      const row = result.rows[0];

      if (!row) {
        return null;
      }

      return normalizeRows([row])[0] as T;
    },

    async run() {
      await pool.query(postgresSql, values);
      return {};
    },
  };
}

export function makeRailwayEnv() {
  return {
    DB: {
      prepare(sql: string) {
        return makeStatement(sql);
      },
    },

    X_BEARER_TOKEN: process.env.X_BEARER_TOKEN,
    BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY,

    APP_PASSWORD: undefined,
    BOT_TICK_SECRET: undefined,

    AI: undefined,
  };
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pulsescan_records (
      id TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pulsescan_records_table_updated
      ON pulsescan_records (table_name, updated_at DESC);
  `);

  console.log("PostgreSQL ready");
}
