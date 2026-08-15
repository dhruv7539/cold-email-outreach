#!/usr/bin/env node
// Applies SQL migration files in db/ in filename order. Idempotent per file via
// a schema_migrations ledger. Intentionally tiny: this product has one schema
// file today and does not need a migration framework.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(__dirname, "..", "db");

async function loadDotEnv() {
  for (const name of [".env.local", ".env"]) {
    try {
      const raw = await fs.readFile(path.resolve(__dirname, "..", name), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      // fine
    }
  }
}

async function main() {
  await loadDotEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (add it to .env.local).");

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const files = (await fs.readdir(dbDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const done = await client.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [file]);
    if (done.rowCount) {
      console.log(`skip ${file} (already applied)`);
      continue;
    }
    const sql = await fs.readFile(path.join(dbDir, file), "utf8");
    console.log(`applying ${file}...`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  await client.end();
  console.log("migrations complete");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
