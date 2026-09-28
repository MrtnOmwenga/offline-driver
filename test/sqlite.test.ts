import { afterEach, describe, expect, it, vi } from 'vitest';
import { Databases, KvStore, kvTableSql, prewarmWebWorker } from '../src/sqlite';
import { fakeExpoSqlite } from './fake-expo-sqlite';

let fake: ReturnType<typeof fakeExpoSqlite>;
afterEach(() => fake?.cleanup());

const setup = () => {
  fake = fakeExpoSqlite();
  const onError = vi.fn();
  const dbs = new Databases({ sqlite: fake.sqlite, listFiles: fake.files, onError })
    .register('catalog', (db) => db.run(kvTableSql()))
    .register('account', (db) => {
      db.run(kvTableSql());
      db.run('CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, body TEXT)');
    }, 'user');
  return { dbs, onError };
};

describe('Databases', () => {
  it('opens each database once, with its schema, one file per scope', () => {
    const { dbs } = setup();
    dbs.get('account', 'ada').run('INSERT INTO drafts VALUES (?, ?)', ['1', 'hello']);
    dbs.get('account', 'ada').run('INSERT INTO drafts VALUES (?, ?)', ['2', 'again']);
    expect(dbs.get('account', 'bob').all('SELECT * FROM drafts')).toEqual([]);
    expect(dbs.get('account', 'ada').get<{ body: string }>('SELECT body FROM drafts WHERE id = ?', ['2'])?.body).toBe('again');
    expect(fake.opened).toEqual(['user-ada.db', 'user-bob.db']);
    expect(fake.files()).toEqual(['user-ada.db', 'user-bob.db']);
  });

  it('rolls a transaction back when it throws', () => {
    const { dbs } = setup();
    const db = dbs.get('account', 'ada');
    expect(() =>
      db.transaction((tx) => {
        tx.run('INSERT INTO drafts VALUES (?, ?)', ['1', 'x']);
        throw new Error('midway');
      }),
    ).toThrow('midway');
    expect(db.all('SELECT * FROM drafts')).toEqual([]);
  });

  it('closes a database that fails to set up, so the retry opens a clean file', () => {
    const { dbs } = setup();
    fake.failNext.exec = true;
    expect(() => dbs.get('catalog')).toThrow('Sync operation timeout');
    expect(fake.open.size).toBe(0);
    expect(() => dbs.get('catalog').all('SELECT * FROM kv')).not.toThrow();
  });

  it('refuses a namespace nobody registered', () => {
    const { dbs } = setup();
    expect(() => dbs.get('nope')).toThrow('no schema registered');
  });

  it("deletes a namespace's files on sign-out, including ones this session never opened", async () => {
    const { dbs } = setup();
    dbs.get('account', 'ada');
    dbs.get('catalog');
    // A file from an earlier session: on disk, never opened now.
    fake.sqlite.openDatabaseSync('user-old.db').closeSync();
    await dbs.deleteNamespaces(['account']);
    expect(fake.files()).toEqual(['catalog.db']);
    // Reopening after sign-out gets a fresh, empty database.
    expect(dbs.get('account', 'ada').all('SELECT * FROM drafts')).toEqual([]);
  });

  it("doesn't let a listing failure block sign-out", async () => {
    fake = fakeExpoSqlite();
    const onError = vi.fn();
    const dbs = new Databases({ sqlite: fake.sqlite, listFiles: () => { throw new Error('EACCES'); }, onError }).register('account', undefined, 'user');
    dbs.get('account', 'ada');
    await dbs.deleteNamespaces(['account']);
    expect(fake.files()).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('deleteAll removes everything opened this session', async () => {
    const { dbs } = setup();
    dbs.get('account', 'ada');
    dbs.get('catalog');
    await dbs.deleteAll();
    expect(fake.files()).toEqual([]);
  });
});

describe('KvStore', () => {
  it('round-trips JSON per scope', () => {
    const { dbs } = setup();
    const lastPage = new KvStore<{ items: string[]; total: number }>((scope) => dbs.get('account', scope), 'drafts:last-page');
    expect(lastPage.get('ada')).toBeNull();
    lastPage.set({ items: ['a'], total: 1 }, 'ada');
    lastPage.set({ items: ['a', 'b'], total: 2 }, 'ada');
    expect(lastPage.get('ada')).toEqual({ items: ['a', 'b'], total: 2 });
    expect(lastPage.get('bob')).toBeNull();
  });

  it('refuses a table name that could inject SQL', () => {
    expect(() => new KvStore(() => null as never, 'k', 'kv; DROP TABLE x')).toThrow('invalid table name');
  });
});

it('prewarmWebWorker opens and deletes a throwaway database, and never throws', async () => {
  const calls: string[] = [];
  await prewarmWebWorker({
    openDatabaseSync: () => null as never,
    openDatabaseAsync: async (name) => (calls.push(`open ${name}`), { closeAsync: async () => void calls.push('close') }),
    deleteDatabaseAsync: async (name) => void calls.push(`delete ${name}`),
  });
  expect(calls).toEqual(['open __offline_driver_warmup__.db', 'close', 'delete __offline_driver_warmup__.db']);
  const onError = vi.fn();
  await prewarmWebWorker({ openDatabaseSync: () => null as never, openDatabaseAsync: async () => Promise.reject(new Error('no wasm')), deleteDatabaseAsync: async () => {} }, onError);
  expect(onError).toHaveBeenCalledOnce();
});
