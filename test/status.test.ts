import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStatusStore, type OfflineStatus } from '../src/core';
import { setup } from './helpers';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it('goes offline → syncing → success → hidden across a recovery', async () => {
  let now = 0;
  const { driver, queue, connectivity } = setup({ online: false, now: () => now });
  const status = createStatusStore(queue, connectivity, { successMs: 2000 });
  const seen: OfflineStatus[] = [status.getStatus()];
  const unsubscribe = status.subscribe(() => seen.push(status.getStatus()));
  const stop = driver.start();
  await driver.enqueue({ type: 'note', text: 'a' });
  await vi.advanceTimersByTimeAsync(0);
  now = 60_000;
  connectivity.set(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(status.getStatus()).toBe('success');
  await vi.advanceTimersByTimeAsync(2000);
  // "hidden" for the instant between the connection returning and the drain starting.
  expect(seen).toEqual(['offline', 'hidden', 'syncing', 'success', 'hidden']);
  stop();
  unsubscribe();
});

it('shows an error while catching up with stuck actions', async () => {
  const { queue, connectivity } = setup();
  const status = createStatusStore(queue, connectivity);
  const unsubscribe = status.subscribe(() => {});
  const a = await queue.enqueue({ type: 'note' });
  await queue.enqueue({ type: 'note' });
  await queue.deadLetter(a.id);
  queue.setDraining(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(status.getStatus()).toBe('error');
  unsubscribe();
});

it("stays hidden for routine online saves (they don't publish draining)", async () => {
  const { driver, queue, connectivity } = setup();
  const status = createStatusStore(queue, connectivity);
  const seen: OfflineStatus[] = [];
  const unsubscribe = status.subscribe(() => seen.push(status.getStatus()));
  const stop = driver.start();
  await driver.enqueue({ type: 'note', text: 'a' });
  await vi.runAllTimersAsync();
  expect(await queue.read()).toEqual([]);
  expect(seen).toEqual([]);
  stop();
  unsubscribe();
});
