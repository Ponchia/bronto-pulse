import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SqlDriver, Statement } from './driver.js';
export class SqliteDriver implements SqlDriver {
  readonly database: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') {
      const parent = dirname(resolve(path));
      mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(path, { timeout: 5000 });
    this.database.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;',
    );
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  async all<T extends Record<string, unknown>>(s: Statement): Promise<T[]> {
    return this.database.prepare(s.sql).all(...(s.params ?? [])) as T[];
  }
  async batch(statements: Statement[]): Promise<void> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const s of statements) this.database.prepare(s.sql).run(...(s.params ?? []));
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  async readBatch(statements: Statement[]): Promise<Record<string, unknown>[][]> {
    this.database.exec('BEGIN');
    try {
      const rows = statements.map(
        (s) => this.database.prepare(s.sql).all(...(s.params ?? [])) as Record<string, unknown>[],
      );
      this.database.exec('COMMIT');
      return rows;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.database.close();
  }
}
