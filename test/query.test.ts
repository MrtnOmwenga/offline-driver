import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { mergeBy, offlineQuery } from '../src/core';

type Item = { id: string; at: number; v: number };
const item = fc.record({ id: fc.constantFrom('a', 'b', 'c', 'd', 'e'), at: fc.integer({ min: 0, max: 100 }), v: fc.nat() });
const merge = (existing: Item[], fetched: Item[]) => mergeBy({ existing, fetched, getKey: (i) => i.id, getSortValue: (i) => i.at });

describe('mergeBy', () => {
  it('keeps every key once, prefers the fetched copy, and sorts newest first', () => {
    fc.assert(
      fc.property(fc.array(item), fc.array(item), (existing, fetched) => {
        const merged = merge(existing, fetched);
        const keys = new Set([...existing, ...fetched].map((i) => i.id));
        expect(merged.map((i) => i.id).sort()).toEqual([...keys].sort());
        for (const m of merged) {
          const lastFetched = fetched.filter((f) => f.id === m.id).at(-1);
          if (lastFetched) expect(m).toBe(lastFetched);
        }
        for (let i = 1; i < merged.length; i++) expect(merged[i - 1]!.at).toBeGreaterThanOrEqual(merged[i]!.at);
      }),
    );
  });

  it('is idempotent: merging the same page twice changes nothing', () => {
    fc.assert(
      fc.property(fc.array(item), fc.array(item), (existing, fetched) => {
        const once = merge(existing, fetched);
        expect(merge(once, fetched)).toEqual(once);
      }),
    );
  });
});

describe('offlineQuery', () => {
  const page = { items: [1], total: 1 };
  const empty = { items: [], total: 0 };

  it('fetches and caches when online', async () => {
    const toCache = vi.fn();
    const query = offlineQuery({ fromCache: () => null, fromNetwork: async () => page, toCache, fallback: empty });
    expect(await query()).toBe(page);
    expect(toCache).toHaveBeenCalledWith(page);
  });

  it("doesn't touch the network when known offline", async () => {
    const fromNetwork = vi.fn();
    const query = offlineQuery({ fromCache: () => page, fromNetwork, toCache: vi.fn(), fallback: empty, isOffline: () => true });
    expect(await query()).toBe(page);
    expect(fromNetwork).not.toHaveBeenCalled();
  });

  it('serves the cache, or the fallback, on a network error', async () => {
    const down = async () => Promise.reject(new TypeError('Network request failed'));
    expect(await offlineQuery({ fromCache: () => page, fromNetwork: down, toCache: vi.fn(), fallback: empty })()).toBe(page);
    expect(await offlineQuery({ fromCache: () => null, fromNetwork: down, toCache: vi.fn(), fallback: empty })()).toBe(empty);
  });

  it('throws any other error', async () => {
    const query = offlineQuery({
      fromCache: () => page,
      fromNetwork: async () => Promise.reject(Object.assign(new Error('Forbidden'), { status: 403 })),
      toCache: vi.fn(),
      fallback: empty,
    });
    await expect(query()).rejects.toThrow('Forbidden');
  });
});
