import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { memoryStorage, Queue } from '../src/core';

const newQueue = () => {
  const storage = memoryStorage();
  const onError = vi.fn();
  return { storage, onError, queue: new Queue({ storage, onError }) };
};

describe('Queue', () => {
  it('persists actions in order, with ids and bookkeeping', async () => {
    const { queue, storage } = newQueue();
    const a = await queue.enqueue({ type: 'note' });
    const b = await queue.enqueue({ type: 'note' });
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ attempts: 0, type: 'note' });
    expect((await queue.read()).map((x) => x.id)).toEqual([a.id, b.id]);
    // Survives a restart: a new Queue on the same storage sees the same actions.
    expect(await new Queue({ storage }).read()).toHaveLength(2);
  });

  it('never loses an action to concurrent writes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom('enqueue', 'bump', 'remove'), { minLength: 1, maxLength: 40 }), async (ops) => {
        const { queue } = newQueue();
        const seed = await queue.enqueue({ type: 'seed' });
        // Everything fired at once, as a burst of taps would.
        const results = await Promise.all(
          ops.map((op) =>
            op === 'enqueue' ? queue.enqueue({ type: 'note' }) : op === 'bump' ? queue.incrementAttempts(seed.id) : queue.remove('missing'),
          ),
        );
        const stored = await queue.read();
        const enqueued = results.filter((r) => r !== undefined) as { id: string }[];
        expect(stored.map((a) => a.id)).toEqual([seed.id, ...enqueued.map((a) => a.id)]);
        expect(stored[0]!.attempts).toBe(ops.filter((op) => op === 'bump').length);
      }),
    );
  });

  it('dead-letters, revives and discards stuck actions', async () => {
    const { queue } = newQueue();
    const a = await queue.enqueue({ type: 'note' });
    const b = await queue.enqueue({ type: 'note' });
    await queue.deadLetter(a.id);
    const stored = await queue.read();
    expect(queue.isStuck(stored[0]!)).toBe(true);
    expect(queue.hasStuck(stored)).toBe(true);
    expect(await queue.hasPending()).toBe(true); // b

    expect((await queue.reviveStuck()).map((x) => x.id)).toEqual([a.id]);
    expect((await queue.read())[0]!.attempts).toBe(0);

    await queue.deadLetter(a.id);
    expect((await queue.discardStuck()).map((x) => x.id)).toEqual([a.id]);
    expect((await queue.read()).map((x) => x.id)).toEqual([b.id]);
  });

  it('counts attempts up to the limit', async () => {
    const { queue } = newQueue();
    const a = await queue.enqueue({ type: 'note' });
    for (let i = 0; i < queue.maxAttempts; i++) await queue.incrementAttempts(a.id);
    expect(await queue.hasPending()).toBe(false);
  });

  it('replaces matching actions in one write, for coalescing', async () => {
    const { queue } = newQueue();
    await queue.enqueue({ type: 'count', n: 1 } as never);
    await queue.enqueue({ type: 'other' });
    await queue.replace((a) => a.type === 'count', { id: 'x', type: 'count', attempts: 0, createdAt: 0, n: 2 } as never);
    expect((await queue.read()).map((a) => a.type)).toEqual(['other', 'count']);
    await queue.replace((a) => a.type === 'count', null);
    expect(await queue.read()).toHaveLength(1);
  });

  it('clears a corrupted payload instead of failing forever', async () => {
    const { queue, storage, onError } = newQueue();
    storage.data.set('offline-driver/queue', '{"half written');
    expect(await queue.read()).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
    await queue.enqueue({ type: 'note' });
    expect(await queue.read()).toHaveLength(1);
  });

  it('signals changes, draining and outcomes', async () => {
    const { queue } = newQueue();
    const changes = vi.fn();
    const draining = vi.fn();
    const off = queue.onChange(changes);
    queue.onDrainingChange(draining);
    await queue.enqueue({ type: 'note' });
    await queue.clear();
    off();
    await queue.enqueue({ type: 'note' });
    expect(changes).toHaveBeenCalledTimes(2);

    queue.setDraining(true);
    queue.setDraining(true);
    queue.setDraining(false);
    expect(draining).toHaveBeenCalledTimes(2);
  });

  it('keeps the lock usable after an operation throws', async () => {
    const { queue } = newQueue();
    await expect(queue.withLock(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await queue.enqueue({ type: 'note' });
    expect(await queue.read()).toHaveLength(1);
  });
});
