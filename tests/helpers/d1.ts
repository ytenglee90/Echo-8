import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Real SQLite constraints and rollback, behind the D1 binding surface. */
export class SQLiteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  readonly sizeBytes = 12_500_000;
  constructor(schema = new URL('../../cloud/data-worker/schema.sql', import.meta.url)) {
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    this.sqlite.exec(readFileSync(schema, 'utf8'));
  }
  prepare(sql: string) {
    const { sqlite, sizeBytes } = this;
    let args: (string | number | null)[] = [];
    const statement = {
      bind(...values: unknown[]) { args = values.map(value => value == null ? null : value as string | number); return statement; },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...args), meta: { size_after: sizeBytes } }; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async run() { const value = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(value.changes), size_after: sizeBytes } }; },
    };
    return statement;
  }
  async batch(statements: Array<{ all(): Promise<unknown> }>) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) {
        // RETURNING is unnecessary here; all() also executes DML and reports changes.
        const result = await statement.all() as { meta: Record<string, unknown> };
        result.meta.changes = Number((this.sqlite.prepare('SELECT changes() AS count').get() as {count:number}).count);
        results.push(result);
      }
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  get checkpointParts() {
    const result = new Map<string, unknown[]>();
    for (const row of this.sqlite.prepare('SELECT project_id,revision,part_index FROM checkpoint_parts').all()) {
      const key = `${row.project_id}:${row.revision}`;
      result.set(key, [...result.get(key) ?? [], row]);
    }
    return result;
  }
}
