import type { Connectivity } from './driver';
import type { Queue } from './queue';

/**
 * What an offline status bar should show:
 *
 * - `offline`: no connection.
 * - `syncing`: catching up after being offline.
 * - `error`: catching up, but some actions are stuck.
 * - `success`: caught up; shown briefly, then `hidden`.
 */
export type OfflineStatus = 'hidden' | 'syncing' | 'offline' | 'error' | 'success';

/**
 * The status bar's state, derived from the queue and the connection, as a subscribable store
 * (the shape React's useSyncExternalStore wants). Framework-free so it can be tested, and used
 * outside React.
 */
export const createStatusStore = (queue: Queue, connectivity: Connectivity, options: { successMs?: number } = {}) => {
  let size = 0;
  let stuck = false;
  let online = connectivity.isOnline();
  let draining = queue.isDraining();
  let success = false;
  let successTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  let stops: (() => void)[] = [];

  const compute = (): OfflineStatus => {
    if (!online) return 'offline';
    // Until the drain says it's done: the queue empties a moment before it does, and deriving
    // "syncing" from the queue's size alone flickers syncing → hidden → success.
    if (draining) return stuck && size > 0 ? 'error' : 'syncing';
    return success ? 'success' : 'hidden';
  };
  let status = compute();
  const update = () => {
    const next = compute();
    if (next === status) return;
    status = next;
    listeners.forEach((l) => l());
  };
  const refresh = async () => {
    const actions = await queue.read();
    size = actions.length;
    stuck = queue.hasStuck(actions);
    update();
  };

  const start = () => {
    online = connectivity.isOnline();
    draining = queue.isDraining();
    update();
    void refresh();
    stops = [
      queue.onChange(() => void refresh()),
      connectivity.subscribe((value) => {
        online = value;
        update();
      }),
      queue.onDrainingChange(() => {
        const now = queue.isDraining();
        // Finished catching up with nothing left: say so, briefly.
        if (draining && !now && size === 0) {
          clearTimeout(successTimer);
          success = true;
          successTimer = setTimeout(() => {
            success = false;
            update();
          }, options.successMs ?? 2000);
        }
        draining = now;
        update();
      }),
    ];
  };

  return {
    getStatus: (): OfflineStatus => status,
    subscribe: (listener: () => void): (() => void) => {
      if (listeners.size === 0) start();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stops.forEach((stop) => stop());
          clearTimeout(successTimer);
        }
      };
    },
  };
};
export type StatusStore = ReturnType<typeof createStatusStore>;
