import { createContext, createElement, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createStatusStore, type OfflineDriver, type OfflineStatus, type QueueOutcomeEvent, type StatusStore } from '../core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDriver = OfflineDriver<any, any>;

const Context = createContext<{ driver: AnyDriver; status: StatusStore } | null>(null);

/**
 * Starts the driver for as long as it's mounted (once, at the app root) and makes it available
 * to the hooks below. The driver itself is created outside React: it's the app's one outbox, not
 * per-render state.
 */
export function OfflineProvider({ driver, successMs, children }: { driver: AnyDriver; successMs?: number; children?: ReactNode }) {
  const status = useMemo(() => createStatusStore(driver.queue, driver.connectivity, { successMs }), [driver, successMs]);
  useEffect(() => driver.start(), [driver]);
  return createElement(Context.Provider, { value: { driver, status } }, children);
}

const useOffline = () => {
  const value = useContext(Context);
  if (!value) throw new Error('offline-driver: wrap the app in <OfflineProvider>');
  return value;
};

/** The driver, for enqueueing actions from components. */
export const useOfflineDriver = <T extends AnyDriver = AnyDriver>(): T => useOffline().driver as T;

/**
 * What an offline status bar should show. Every screen reads the same store, so a screen mounted
 * mid-sync shows "syncing" at once rather than only the screen that was on top when it started.
 */
export const useOfflineStatus = (): OfflineStatus => {
  const { status } = useOffline();
  return useSyncExternalStore(status.subscribe, status.getStatus, status.getStatus);
};

/**
 * Calls `listener` with each action's definitive outcome: for "your change was saved" or
 * "couldn't save" notices after the fact. Ordinary instant saves have `wasDeferred: false`; the
 * screen's own optimistic UI already covered those, so most apps skip them.
 */
export const useQueueOutcomes = (listener: (event: QueueOutcomeEvent) => void): void => {
  const { driver } = useOffline();
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => driver.queue.onOutcome((event) => latest.current(event)), [driver]);
};
