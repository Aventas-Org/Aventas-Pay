/**
 * Minimal SQL executor port.
 *
 * Both Cloudflare D1 and bun:sqlite (used in tests, and the same SQLite engine
 * family D1 is built on) can be adapted to this port with a handful of lines:
 *
 *   D1:         db.bind(...params).run()  -> meta.changes
 *               db.bind(...params).first()/.all()
 *   bun:sqlite  db.query(sql).run(params) -> changes
 *               db.query(sql).get(params) / .all(params)
 *
 * Every call takes the SQL text and positional parameters separately so that
 * NO caller can build a query by interpolating values into SQL — this is the
 * structural guarantee behind the SQL-injection safety of the checkout store.
 */

export type SqlValue = string | number | null;

export interface SqlExecutor {
  /**
   * INSERT/UPDATE/DELETE. Returns the affected-row count so callers can
   * implement optimistic concurrency guards. Rejects with a ConstraintViolation
   * on UNIQUE/CHECK failure.
   */
  run(sql: string, params: SqlValue[]): Promise<{ rowsAffected: number }>;
  /** Single-row SELECT, or null. */
  get<T>(sql: string, params: SqlValue[]): Promise<T | null>;
  /** Multi-row SELECT. */
  all<T>(sql: string, params: SqlValue[]): Promise<T[]>;
}

/**
 * Raised when a database constraint rejects a statement. `unique` is true for
 * UNIQUE violations (used by the store to raise IdempotencyConflict) and false
 * for CHECK/foreign-key/NOT NULL violations, which are programming errors.
 */
export class ConstraintViolation extends Error {
  readonly unique: boolean;

  constructor(message: string, unique: boolean) {
    super(message);
    this.name = "ConstraintViolation";
    this.unique = unique;
  }
}

/** Recognizes SQLite/D1 constraint errors by their stable message prefix. */
export function classifyConstraintError(err: unknown): ConstraintViolation | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("UNIQUE constraint failed")) {
    return new ConstraintViolation(message, true);
  }
  if (
    message.includes("CHECK constraint failed") ||
    message.includes("FOREIGN KEY constraint failed") ||
    message.includes("NOT NULL constraint failed")
  ) {
    return new ConstraintViolation(message, false);
  }
  return null;
}
