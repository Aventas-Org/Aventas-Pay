/**
 * bun:sqlite adapter for the SqlExecutor port, plus a helper that applies the
 * real migration file to a fresh in-memory database. This is the same SQLite
 * engine family Cloudflare D1 runs on, so schema, constraints and query plans
 * exercised here are representative of staging D1.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyConstraintError,
  SqlExecutor,
  SqlValue,
} from "../../src/adapters/sqlPort";

export function openDatabase(): Database {
  return new Database(":memory:", { create: true });
}

export class BunSqliteExecutor implements SqlExecutor {
  constructor(private readonly db: Database) {}

  async run(sql: string, params: SqlValue[]): Promise<{ rowsAffected: number }> {
    try {
      const result = this.db.query(sql).run(...params);
      return { rowsAffected: result.changes };
    } catch (err) {
      const violation = classifyConstraintError(err);
      if (violation) throw violation;
      throw err;
    }
  }

  async get<T>(sql: string, params: SqlValue[]): Promise<T | null> {
    try {
      return (this.db.query(sql).get(...params) as T | undefined) ?? null;
    } catch (err) {
      const violation = classifyConstraintError(err);
      if (violation) throw violation;
      throw err;
    }
  }

  async all<T>(sql: string, params: SqlValue[]): Promise<T[]> {
    try {
      return this.db.query(sql).all(...params) as T[];
    } catch (err) {
      const violation = classifyConstraintError(err);
      if (violation) throw violation;
      throw err;
    }
  }
}

const MIGRATION_FILES = [
  "0001_checkout_sessions.sql",
  "0002_rate_limits.sql",
  "0003_verification_uniqueness.sql",
] as const;

/** Applies the real migration files (byte-identical to what D1 would run). */
export function applyMigrations(db: Database): void {
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(
      join(import.meta.dir, "..", "..", "migrations", file),
      "utf8",
    );
    db.run(sql);
  }
}

export function migratedExecutor(): { db: Database; executor: BunSqliteExecutor } {
  const db = openDatabase();
  applyMigrations(db);
  return { db, executor: new BunSqliteExecutor(db) };
}
