export type SqlValue = string | number | null;
export interface Statement {
  sql: string;
  params?: SqlValue[];
}
export interface SqlDriver {
  all<T extends Record<string, unknown>>(statement: Statement): Promise<T[]>;
  /** Each batch MUST commit atomically or roll back all statements. */
  batch(statements: Statement[]): Promise<void>;
  /** All reads observe the same database snapshot, even if writers start concurrently. */
  readBatch(statements: Statement[]): Promise<Record<string, unknown>[][]>;
  close?(): void;
}
export interface D1Like {
  prepare(sql: string): { bind(...values: SqlValue[]): D1Prepared };
  batch(statements: D1Prepared[]): Promise<unknown>;
}
export interface D1Prepared {
  all<T>(): Promise<{ results: T[] }>;
}
export class D1Driver implements SqlDriver {
  constructor(private readonly db: D1Like) {}
  async all<T extends Record<string, unknown>>(s: Statement): Promise<T[]> {
    return (
      await this.db
        .prepare(s.sql)
        .bind(...(s.params ?? []))
        .all<T>()
    ).results;
  }
  async batch(statements: Statement[]): Promise<void> {
    if (statements.length)
      await this.db.batch(statements.map((s) => this.db.prepare(s.sql).bind(...(s.params ?? []))));
  }
  async readBatch(statements: Statement[]): Promise<Record<string, unknown>[][]> {
    if (!statements.length) return [];
    const results = await this.db.batch(
      statements.map((s) => this.db.prepare(s.sql).bind(...(s.params ?? []))),
    );
    if (!Array.isArray(results) || results.length !== statements.length)
      throw new Error('D1 snapshot returned an invalid result set.');
    return results.map((result) => {
      if (!result || !Array.isArray(result.results)) throw new Error('D1 snapshot omitted rows.');
      return result.results as Record<string, unknown>[];
    });
  }
}
