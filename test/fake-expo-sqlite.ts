import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteHandle, SqliteModule, SqlParam } from '../src/sqlite';

/** expo-sqlite's synchronous API over better-sqlite3, on real files in a temporary directory. */
export const fakeExpoSqlite = () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-driver-'));
  const open = new Set<string>();
  const opened: string[] = [];
  const failNext = { exec: false };
  const sqlite: SqliteModule = {
    openDatabaseSync(filename): SqliteHandle {
      const db = new Database(join(dir, filename));
      open.add(filename);
      opened.push(filename);
      return {
        execSync: (sql) => {
          if (failNext.exec) {
            failNext.exec = false;
            throw new Error('Sync operation timeout');
          }
          db.exec(sql);
        },
        runSync: (sql, ...params: SqlParam[]) => db.prepare(sql).run(...params),
        getAllSync: <T>(sql: string, ...params: SqlParam[]) => db.prepare(sql).all(...params) as T[],
        getFirstSync: <T>(sql: string, ...params: SqlParam[]) => (db.prepare(sql).get(...params) as T | undefined) ?? null,
        withTransactionSync: (task) => db.transaction(task)(),
        closeSync: () => {
          db.close();
          open.delete(filename);
        },
      };
    },
    async deleteDatabaseAsync(filename) {
      if (open.has(filename)) throw new Error(`${filename} is still open`);
      for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, filename + suffix), { force: true });
    },
  };
  return {
    sqlite,
    open,
    opened,
    failNext,
    files: () => readdirSync(dir).filter((f) => f.endsWith('.db')).sort(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};
