import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueOutcomeEvent } from '../src/core';
import { setup } from './helpers';

const note = (text: string) => ({ type: 'note' as const, text });

describe('drain', () => {
  it('sends queued actions in order and removes them', async () => {
    const { driver, executed, queue } = setup();
    await driver.enqueue(note('a'));
    await driver.enqueue(note('b'));
    await driver.drain();
    expect(executed).toEqual(['a', 'b']);
    expect(await queue.read()).toEqual([]);
  });

  it('does nothing offline', async () => {
    const { driver, executed } = setup({ online: false });
    await driver.enqueue(note('a'));
    await driver.drain();
    expect(executed).toEqual([]);
  });

  it("doesn't count a dropped connection as an attempt, and stops there to keep the order", async () => {
    const { driver, executed, queue } = setup({ outcomes: ['network'] });
    await driver.enqueue(note('a'));
    await driver.enqueue(note('b'));
    await driver.drain();
    expect(executed).toEqual(['a']);
    expect((await queue.read()).map((a) => a.attempts)).toEqual([0, 0]);
    // Any number of blips later, it still goes through.
    await driver.drain();
    expect(executed).toEqual(['a', 'a', 'b']);
    expect(await queue.read()).toEqual([]);
  });

  it('retries a failure up to the limit, then dead-letters it once', async () => {
    const onStuck = vi.fn();
    const { driver, queue } = setup();
    driver.register('pin', { execute: async () => 'failure', onStuck });
    const outcomes: QueueOutcomeEvent[] = [];
    queue.onOutcome((e) => outcomes.push(e));
    await driver.enqueue({ type: 'pin', noteId: 'n1' });
    for (let i = 0; i < 5; i++) await driver.drain();
    const [action] = await queue.read();
    expect(action!.attempts).toBe(3);
    expect(onStuck).toHaveBeenCalledOnce();
    expect(outcomes).toEqual([expect.objectContaining({ outcome: 'failure', isStuck: true })]);
  });

  it('dead-letters a terminal rejection on the first attempt', async () => {
    const onStuck = vi.fn();
    const { driver, queue } = setup();
    driver.register('pin', { execute: async () => 'terminal', onStuck });
    await driver.enqueue({ type: 'pin', noteId: 'n1' });
    await driver.enqueue(note('after'));
    await driver.drain();
    expect(onStuck).toHaveBeenCalledWith(expect.objectContaining({ noteId: 'n1' }), { user: 'ada' });
    // It doesn't hold up what's behind it.
    expect((await queue.read()).map((a) => a.type)).toEqual(['pin']);
  });

  it('runs each afterDrain hook once, for types that succeeded, with everything attempted', async () => {
    const shared = vi.fn(async () => {});
    const { driver } = setup({ outcomes: ['success', 'success'] });
    driver.register('note', { execute: async () => 'success', afterDrain: shared });
    driver.register('pin', { execute: async () => 'success', afterDrain: shared });
    await driver.enqueue(note('a'));
    await driver.enqueue(note('b'));
    await driver.enqueue({ type: 'pin', noteId: 'n' });
    await driver.drain();
    expect(shared).toHaveBeenCalledOnce();
    expect((shared.mock.calls[0] as unknown[])[1]).toHaveLength(3);
  });

  it("still runs afterDrain for what succeeded before the connection dropped", async () => {
    const afterDrain = vi.fn(async () => {});
    const { driver } = setup();
    let calls = 0;
    driver.register('note', { execute: async () => (calls++ === 0 ? 'success' : 'network'), afterDrain });
    await driver.enqueue(note('a'));
    await driver.enqueue(note('b'));
    await driver.drain();
    expect(afterDrain).toHaveBeenCalledOnce();
  });

  it('treats a throwing handler or a missing one as a failure, and reports it', async () => {
    const { driver, queue, errors } = setup();
    driver.register('pin', { execute: async () => Promise.reject(new Error('bug')) });
    await driver.enqueue({ type: 'pin', noteId: 'n' });
    await driver.enqueue({ type: 'gone' } as never);
    await driver.drain();
    expect((await queue.read()).map((a) => a.attempts)).toEqual([1, 1]);
    expect(errors.map(([, c]) => c)).toEqual(['offline-driver: pin threw', 'offline-driver: execute']);
  });

  it('is single-flight', async () => {
    const { driver, executed } = setup();
    await driver.enqueue(note('a'));
    await Promise.all([driver.drain(), driver.drain(), driver.drain()]);
    expect(executed).toEqual(['a']);
  });

  it('marks slow or retried successes as deferred', async () => {
    let now = 0;
    const { driver, queue } = setup({ outcomes: ['failure', 'success', 'success'], now: () => now });
    const events: QueueOutcomeEvent[] = [];
    queue.onOutcome((e) => events.push(e));
    await driver.enqueue(note('retried'));
    await driver.drain();
    await driver.drain();
    await driver.enqueue(note('quick'));
    now = 1000;
    await driver.drain();
    await driver.enqueue(note('slow'));
    now = 10_000;
    await driver.drain();
    expect(events.map((e) => [(e.action as { text?: string }).text, e.wasDeferred])).toEqual([
      ['retried', true],
      ['quick', false],
      ['slow', true],
    ]);
  });
});

describe('start', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('drains on reconnect, and shows "syncing" only after a real offline period', async () => {
    let now = 0;
    const { driver, connectivity, queue } = setup({ online: false, now: () => now });
    const draining: boolean[] = [];
    queue.onDrainingChange(() => draining.push(queue.isDraining()));
    const stop = driver.start();
    await driver.enqueue(note('a'));

    // Back within the threshold: e.g. the network library's first probe resolving at startup.
    now = 500;
    connectivity.set(true);
    await vi.runAllTimersAsync();
    expect(await queue.read()).toEqual([]);
    expect(draining).toEqual([]);

    connectivity.set(false);
    await driver.enqueue(note('b'));
    now = 10_000;
    connectivity.set(true);
    await vi.runAllTimersAsync();
    expect(draining).toEqual([true, false]);
    stop();
  });

  it('revives stuck actions once per session', async () => {
    const { driver, connectivity, queue } = setup({ online: false });
    const a = await driver.enqueue(note('a'));
    await queue.deadLetter(a.id);
    const stop = driver.start();
    connectivity.set(true);
    await vi.runAllTimersAsync();
    expect(await queue.read()).toEqual([]);

    const b = await driver.enqueue(note('b'));
    await queue.deadLetter(b.id);
    connectivity.set(false);
    connectivity.set(true);
    await vi.runAllTimersAsync();
    expect((await queue.read()).map((x) => x.id)).toEqual([b.id]);
    stop();
  });

  it('debounces queue changes so a burst drains once', async () => {
    const { driver, executed } = setup();
    const drain = vi.spyOn(driver, 'drain');
    const stop = driver.start();
    await vi.runAllTimersAsync();
    drain.mockClear();
    for (const text of ['a', 'b', 'c']) {
      await driver.enqueue(note(text));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.runAllTimersAsync();
    expect(drain).toHaveBeenCalledOnce();
    expect(executed).toEqual(['a', 'b', 'c']);
    stop();
  });

  it("doesn't let the drain's own bookkeeping trigger another drain", async () => {
    // Otherwise a failing action is retried every half second and stuck within two seconds.
    const { driver, queue } = setup({ outcomes: ['failure', 'failure', 'failure'] });
    const stop = driver.start();
    await driver.enqueue(note('a'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await queue.read())[0]!.attempts).toBe(1);
    stop();
  });

  it('drains when the app returns to the foreground, and stops cleanly', async () => {
    const { queue, connectivity } = setup();
    const foreground = new Set<() => void>();
    const { OfflineDriver } = await import('../src/core');
    const driver = new OfflineDriver({
      queue,
      connectivity,
      context: () => ({}),
      lifecycle: { onForeground: (l) => (foreground.add(l), () => foreground.delete(l)) },
    });
    const drain = vi.spyOn(driver, 'drain');
    const stop = driver.start();
    await vi.runAllTimersAsync();
    drain.mockClear();
    foreground.forEach((l) => l());
    expect(drain).toHaveBeenCalledOnce();
    stop();
    expect(foreground.size).toBe(0);
  });
});
