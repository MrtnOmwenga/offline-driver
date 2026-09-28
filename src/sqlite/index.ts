/*
 * Owning the app's SQLite databases: opening them (once), building their schemas, and deleting
 * them on sign-out. Written against expo-sqlite's synchronous API, passed in rather than
 * imported, so it runs anywhere something provides that API (tests use better-sqlite3).
 *
 * Synchronous on purpose. An async executor was tried and removed: every `await` hands control
 * back to the event loop, where a synchronous call from elsewhere in the app can interleave with
 * it on expo-sqlite's shared web worker and corrupt both results. Synchronous code can't be
 * preempted. A write too big for one synchronous transaction should become several smaller ones.
 */

/** Bind values a parameterised statement accepts. */
export type SqlParam = string | number | null;

/** The part of an expo-sqlite `SQLiteDatabase` this uses. */
export interface SqliteHandle {
  execSync(sql: string): void;
  runSync(sql: string, ...params: SqlParam[]): unknown;
  getAllSync<T>(sql: string, ...params: SqlParam[]): T[];
  getFirstSync<T>(sql: string, ...params: SqlParam[]): T | null;
  withTransactionSync(task: () => void): void;
  closeSync(): void;
}

/** The part of the expo-sqlite module this uses: `import * as SQLite from 'expo-sqlite'`. */
export interface SqliteModule {
  openDatabaseSync(filename: string): SqliteHandle;
  deleteDatabaseAsync(filename: string): Promise<void>;
  openDatabaseAsync?(filename: string): Promise<{ closeAsync(): Promise<void> }>;
}

/** Runs statements on one database. The only thing application code needs to see. */
export interface SqlExecutor {
  run(sql: string, params?: SqlParam[]): void;
  all<T>(sql: string, params?: SqlParam[]): T[];
  get<T>(sql: string, params?: SqlParam[]): T | null;
  /** Runs `fn` in one transaction. Use the executor it's given: it's the same handle. */
  transaction(fn: (tx: SqlExecutor) => void): void;
}

const executor = (handle: SqliteHandle): SqlExecutor => {
  const exec: SqlExecutor = {
    run: (sql, params = []) => void handle.runSync(sql, ...params),
    all: <T>(sql: string, params: SqlParam[] = []) => handle.getAllSync<T>(sql, ...params),
    get: <T>(sql: string, params: SqlParam[] = []) => handle.getFirstSync<T>(sql, ...params) ?? null,
    transaction: (fn) => handle.withTransactionSync(() => fn(exec)),
  };
  return exec;
};

export interface DatabasesOptions {
  sqlite: SqliteModule;
  /**
   * The database files on disk, by name, for deleting ones this session never opened (sign-out
   * on a shared device must wipe the previous user's data, not only what was touched since
   * launch). See `listDatabaseFiles` in `offline-driver/react-native`. Optional: without it,
   * only databases opened this session are deleted.
   */
  listFiles?: () => string[];
  onError?: (error: unknown, context: string) => void;
}

/**
 * The app's databases, by namespace, and optionally scope: a namespace's schema is registered
 * once, and each scope (per account, per day…) gets its own file with that schema.
 */
export class Databases {
  private readonly schemas = new Map<string, { build?: (db: SqlExecutor) => void; filename: string }>();
  private readonly open = new Map<string, { handle: SqliteHandle; file: string; namespace: string }>();

  constructor(private readonly options: DatabasesOptions) {}

  /**
   * Registers a namespace. `schema` runs whenever one of its files is opened, so write it
   * idempotently (CREATE TABLE IF NOT EXISTS). `filename` defaults to the namespace.
   */
  register = (namespace: string, schema?: (db: SqlExecutor) => void, filename = namespace): this => {
    if (namespace.includes(':')) throw new Error(`namespace "${namespace}" must not contain ":"`);
    this.schemas.set(namespace, { build: schema, filename });
    return this;
  };

  private file = (namespace: string, scope?: string): string => {
    const base = this.schemas.get(namespace)?.filename ?? namespace;
    return scope ? `${base}-${scope}.db` : `${base}.db`;
  };

  /** The database for a namespace (and scope), opened and given its schema on first use. */
  get = (namespace: string, scope?: string): SqlExecutor => executor(this.handle(namespace, scope));

  private handle = (namespace: string, scope?: string): SqliteHandle => {
    if (!this.schemas.has(namespace)) throw new Error(`no schema registered for namespace "${namespace}"`);
    const key = scope ? `${namespace}:${scope}` : namespace;
    const cached = this.open.get(key);
    if (cached) return cached.handle;
    const file = this.file(namespace, scope);
    const handle = this.options.sqlite.openDatabaseSync(file);
    // Setting up takes several more synchronous round trips, and on a slow device any of them can
    // time out. Close the handle if one does: left open and uncached, it would keep its lock on
    // the file, and the retry would open the same file again and race it.
    try {
      handle.execSync('PRAGMA journal_mode = WAL;');
      this.schemas.get(namespace)?.build?.(executor(handle));
    } catch (error) {
      try {
        handle.closeSync();
      } catch (closeError) {
        this.options.onError?.(closeError, 'offline-driver: closing a database that failed to open');
      }
      throw error;
    }
    this.open.set(key, { handle, file, namespace });
    return handle;
  };

  /**
   * Deletes every database of these namespaces, including files from earlier sessions that
   * weren't opened in this one (when `listFiles` is given). For sign-out.
   */
  deleteNamespaces = async (namespaces: string[]): Promise<void> => {
    const wanted = new Set(namespaces);
    const files = new Set<string>();
    for (const [key, db] of this.open) {
      if (!wanted.has(db.namespace)) continue;
      db.handle.closeSync();
      this.open.delete(key);
      files.add(db.file);
    }
    if (this.options.listFiles) {
      try {
        const bases = namespaces.map((n) => this.schemas.get(n)?.filename ?? n);
        for (const name of this.options.listFiles()) {
          if (name.endsWith('.db') && bases.some((base) => name === `${base}.db` || name.startsWith(`${base}-`))) {
            files.add(name);
          }
        }
      } catch (error) {
        // Never let a filesystem quirk block sign-out. The files opened this session still go.
        this.options.onError?.(error, 'offline-driver: listing database files');
      }
    }
    await Promise.all([...files].map((file) => this.options.sqlite.deleteDatabaseAsync(file)));
  };

  /** Closes and deletes every database opened this session. */
  deleteAll = async (): Promise<void> => {
    const files = [...this.open.values()].map((db) => {
      db.handle.closeSync();
      return db.file;
    });
    this.open.clear();
    await Promise.all(files.map((file) => this.options.sqlite.deleteDatabaseAsync(file)));
  };
}

/**
 * A JSON document per key, in a `key TEXT PRIMARY KEY, value TEXT` table: the simplest cache for
 * a list screen's last page. Create the table in the namespace's schema (`kvTableSql`).
 */
export class KvStore<T> {
  constructor(
    private readonly db: (scope?: string) => SqlExecutor,
    private readonly key: string,
    private readonly table = 'kv',
  ) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`invalid table name "${table}"`);
  }

  get = (scope?: string): T | null => {
    const row = this.db(scope).get<{ value: string }>(`SELECT value FROM ${this.table} WHERE key = ?`, [this.key]);
    return row ? (JSON.parse(row.value) as T) : null;
  };

  set = (value: T, scope?: string): void =>
    this.db(scope).run(`INSERT OR REPLACE INTO ${this.table} (key, value) VALUES (?, ?)`, [this.key, JSON.stringify(value)]);
}

export const kvTableSql = (table = 'kv'): string => `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

/**
 * Web only. expo-sqlite's web build starts its worker (a script fetch and WASM compile) on the
 * first call, and a synchronous first call pays that inside a busy-wait with a fixed iteration
 * budget, which throws "Sync operation timeout" on a slow machine. An async open at boot starts
 * the worker early; await it before rendering anything that reads a database and the ordering
 * is guaranteed rather than likely. Never throws: a failed warm-up only loses the head start.
 */
export const prewarmWebWorker = async (sqlite: SqliteModule, onError?: (error: unknown, context: string) => void): Promise<void> => {
  if (!sqlite.openDatabaseAsync) return;
  try {
    const name = '__offline_driver_warmup__.db';
    const db = await sqlite.openDatabaseAsync(name);
    await db.closeAsync();
    await sqlite.deleteDatabaseAsync(name);
  } catch (error) {
    onError?.(error, 'offline-driver: warming up the web SQLite worker');
  }
};
