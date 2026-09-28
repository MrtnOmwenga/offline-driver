import type { ActionDraft, ErrorReporter, QueuedAction, QueueOutcomeEvent } from './types';
import type { QueueStorage } from './storage';

type Listener = () => void;

/**
 * What changed: new work (`enqueue`, `replace`) or bookkeeping (everything the drain does, and
 * the stuck-action controls). Draining on new work only matters: if the drain's own writes
 * triggered another drain, a failing action would burn through all its retries in a second or
 * two instead of once per reconnect or return to the app.
 */
export type QueueChange = 'enqueue' | 'replace' | 'remove' | 'attempt' | 'dead-letter' | 'revive' | 'discard' | 'clear';

export interface QueueOptions {
  storage: QueueStorage;
  /** The storage key. One queue per app, usually. */
  key?: string;
  /** Attempts before an action is dead-lettered ("stuck"). Default 3. */
  maxAttempts?: number;
  onError?: ErrorReporter;
  /** The clock for `createdAt`. */
  now?: () => number;
}

/**
 * A durable outbox: persistence, change signals, retry and dead-letter bookkeeping. It knows
 * nothing about what any action type means or does; that lives in the handlers registered with
 * the driver, which is what lets an app add an action type without touching this class.
 */
export class Queue {
  readonly maxAttempts: number;
  readonly now: () => number;
  private readonly storage: QueueStorage;
  private readonly key: string;
  private readonly onError: ErrorReporter;

  constructor(options: QueueOptions) {
    this.storage = options.storage;
    this.key = options.key ?? 'offline-driver/queue';
    this.maxAttempts = options.maxAttempts ?? 3;
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  // Change signal, so UI can react to the queue without polling.
  private readonly listeners = new Set<(change: QueueChange) => void>();
  onChange = (listener: (change: QueueChange) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // Whether a drain is running. The drain runs once for the app, but status UI is usually
  // mounted per screen; a shared signal lets a screen mounted mid-drain show "syncing" at once
  // instead of only whichever screen happened to be on top when the drain started.
  private readonly drainingListeners = new Set<Listener>();
  private draining = false;
  setDraining = (value: boolean): void => {
    if (this.draining === value) return;
    this.draining = value;
    this.drainingListeners.forEach((l) => l());
  };
  isDraining = (): boolean => this.draining;
  onDrainingChange = (listener: Listener): (() => void) => {
    this.drainingListeners.add(listener);
    return () => this.drainingListeners.delete(listener);
  };

  // Definitive outcomes, for "your change was saved" / "couldn't save" notices after the fact.
  private readonly outcomeListeners = new Set<(event: QueueOutcomeEvent) => void>();
  emitOutcome = (event: QueueOutcomeEvent): void => this.outcomeListeners.forEach((l) => l(event));
  onOutcome = (listener: (event: QueueOutcomeEvent) => void): (() => void) => {
    this.outcomeListeners.add(listener);
    return () => this.outcomeListeners.delete(listener);
  };

  newId = (): string => `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

  // Serialises every read-modify-write. The storage has no transactions, so two mutations fired
  // back to back (a fast double tap) would both read the same snapshot and the second write
  // would silently drop the first one's action. Every mutator runs through this lock.
  private lock: Promise<unknown> = Promise.resolve();
  withLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = this.lock.then(operation, operation);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** The queue, oldest first. Generic over the app's action union for typed reads. */
  read = async <T extends QueuedAction = QueuedAction>(): Promise<T[]> => {
    const raw = await this.storage.getItem(this.key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('queue payload is not an array');
      return parsed as T[];
    } catch (error) {
      // A corrupted payload (the process killed mid-write) would break every future enqueue.
      // Clear it: what it held is unrecoverable either way.
      this.onError(error, 'offline-driver: queue payload was corrupted and has been cleared');
      await this.storage.removeItem(this.key);
      return [];
    }
  };

  private write = async (queue: QueuedAction[], change: QueueChange): Promise<void> => {
    await this.storage.setItem(this.key, JSON.stringify(queue));
    this.listeners.forEach((l) => l(change));
  };

  /** Adds an action (the driver fills in id, attempts and createdAt). */
  enqueue = async <T extends QueuedAction = QueuedAction>(action: ActionDraft<T>): Promise<T> =>
    this.withLock(async () => {
      const full = { ...action, id: this.newId(), attempts: 0, createdAt: this.now() } as T;
      await this.write([...(await this.read()), full], 'enqueue');
      return full;
    });

  /**
   * Replaces the queued actions `match` selects with `next` (or removes them, if `next` is
   * null), in one locked write. For coalescing: ten quick "+1" taps can become one queued update
   * instead of ten requests.
   */
  replace = async (match: (action: QueuedAction) => boolean, next: QueuedAction | null): Promise<void> =>
    this.withLock(async () => {
      const queue = await this.read();
      const kept = queue.filter((a) => !match(a));
      await this.write(next ? [...kept, next] : kept, 'replace');
    });

  remove = async (id: string): Promise<void> =>
    this.withLock(async () => this.write((await this.read()).filter((a) => a.id !== id), 'remove'));

  incrementAttempts = async (id: string): Promise<void> =>
    this.withLock(async () =>
      this.write((await this.read()).map((a) => (a.id === id ? { ...a, attempts: a.attempts + 1 } : a)), 'attempt'),
    );

  /** Straight to the limit, in one write: for a terminal outcome, where retries can't help. */
  deadLetter = async (id: string): Promise<void> =>
    this.withLock(async () =>
      this.write((await this.read()).map((a) => (a.id === id ? { ...a, attempts: this.maxAttempts } : a)), 'dead-letter'),
    );

  isStuck = (action: QueuedAction): boolean => action.attempts >= this.maxAttempts;
  hasStuck = (queue: QueuedAction[]): boolean => queue.some(this.isStuck);

  /** Pending work: actions with retries left. Stuck ones are known failures, not pending. */
  hasPending = async (): Promise<boolean> => (await this.read()).some((a) => !this.isStuck(a));

  /** Gives every stuck action one more chance (attempts back to 0). Returns them. */
  reviveStuck = async (): Promise<QueuedAction[]> =>
    this.withLock(async () => {
      const queue = await this.read();
      const stuck = queue.filter(this.isStuck);
      if (stuck.length) await this.write(queue.map((a) => (this.isStuck(a) ? { ...a, attempts: 0 } : a)), 'revive');
      return stuck;
    });

  /** Drops stuck actions for good, when the user chooses to discard them. Returns them. */
  discardStuck = async (): Promise<QueuedAction[]> =>
    this.withLock(async () => {
      const queue = await this.read();
      const stuck = queue.filter(this.isStuck);
      if (stuck.length) await this.write(queue.filter((a) => !this.isStuck(a)), 'discard');
      return stuck;
    });

  /**
   * Empties the queue, stuck actions included. Call it on sign-out: the queue isn't scoped to a
   * user, and whatever is left would otherwise drain under the next account's session.
   */
  clear = async (): Promise<void> => this.withLock(() => this.write([], 'clear'));
}
