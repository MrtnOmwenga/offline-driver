// @vitest-environment jsdom
import { act, render, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QueueOutcomeEvent } from '../src/core';
import { OfflineProvider, useOfflineDriver, useOfflineStatus, useQueueOutcomes } from '../src/react';
import { setup } from './helpers';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it('starts the driver, and the hooks read its status and outcomes', async () => {
  let now = 0;
  const { driver, connectivity } = setup({ online: false, now: () => now });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(OfflineProvider, { driver }, children);
  const events: QueueOutcomeEvent[] = [];
  const { result, unmount } = renderHook(
    () => {
      useQueueOutcomes((e) => events.push(e));
      return { status: useOfflineStatus(), driver: useOfflineDriver<typeof driver>() };
    },
    { wrapper },
  );
  expect(result.current.status).toBe('offline');
  expect(() => driver.start()).toThrow('already started');

  await act(async () => {
    await result.current.driver.enqueue({ type: 'note', text: 'hi' });
    now = 60_000;
    connectivity.set(true);
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(result.current.status).toBe('success');
  expect(events).toEqual([expect.objectContaining({ outcome: 'success', wasDeferred: true })]);
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(result.current.status).toBe('hidden');
  unmount();
  // Stopped with the provider, so it can be started again.
  driver.start()();
});

it('explains a missing provider', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const Probe = () => (useOfflineStatus(), null);
  expect(() => render(createElement(Probe))).toThrow('wrap the app in <OfflineProvider>');
  spy.mockRestore();
});
