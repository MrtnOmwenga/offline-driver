import type { Queue } from './queue';
import type { ActionContext, ActionDraft, ActionHandler, ErrorReporter, QueuedAction } from './types';

/** Whether the device is online, and when that changes. See `offline-driver/react-native`. */
export interface Connectivity {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

/** When the app returns to the foreground. Optional: without it, foregrounding doesn't drain. */
export interface Lifecycle {
  onForeground(listener: () => void): () => void;
}

export interface DriverOptions<TContext extends ActionContext> {
  queue: Queue;
  connectivity: Connectivity;
  lifecycle?: Lifecycle;
  /** What handlers receive, read fresh at the start of each drain (the user may have changed). */
  context: () => TContext;
  onError?: ErrorReporter;
  /** Debug logging: every attempt and its outcome. */
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /**
   * How long the queue must be quiet before a change triggers a drain. Lets rapid taps coalesce
   * (see `Queue.replace`) before the drain reads the queue, instead of draining the first tap
   * while the rest are still arriving. Default 500 ms.
   */
  debounceMs?: number;
  /**
   * How long the device must have been offline for reconnecting to count as a recovery worth
   * showing "syncing…" for. Network libraries commonly start out "offline" until their first
   * probe resolves a moment later; that isn't an offline period. Default 2 s.
   */
  offlineThresholdMs?: number;
  /**
   * An action that succeeds within this long of being queued reads as ordinary online use;
   * anything slower (or retried) is reported as deferred, e.g. for a "your order was sent"
   * notice. Default 5 s.
   */
  deferredThresholdMs?: number;
  /** Defaults to the queue's clock. */
  now?: () => number;
}

/**
 * The outbox's engine: dispatches queued actions to their handlers and settles each by its
 * outcome. It deliberately knows nothing about what any action type is or does, so adding an
 * action type never means touching this file.
 */
export class OfflineDriver<TAction extends QueuedAction = QueuedAction, TContext extends ActionContext = ActionContext> {
  readonly queue: Queue;
  readonly connectivity: Connectivity;
  private readonly handlers = new Map<string, ActionHandler<TAction, TContext>>();
  private readonly options: DriverOptions<TContext>;
  private readonly now: () => number;
  private running = false;
  private revived = false;
  private offlineSince: number | null = null;
  private started = false;

  constructor(options: DriverOptions<TContext>) {
    this.options = options;
    this.queue = options.queue;
    this.connectivity = options.connectivity;
    this.now = options.now ?? options.queue.now;
  }

  /** Registers the handler for one action type. */
  register = <T extends TAction['type']>(
    type: T,
    handler: ActionHandler<Extract<TAction, { type: T }>, TContext>,
  ): this => {
    this.handlers.set(type, handler as unknown as ActionHandler<TAction, TContext>);
    return this;
  };

  /** Queues an action. The drain picks it up (after the debounce) if the device is online. */
  enqueue = <T extends TAction>(action: ActionDraft<T>): Promise<T> => this.queue.enqueue<T>(action);

  private report = (error: unknown, context: string): void => this.options.onError?.(error, context);
  private log = (message: string, detail?: Record<string, unknown>): void => this.options.log?.(message, detail);

  /**
   * Attempts every action with retries left, oldest first, one at a time: order matters (an
   * edit queued after a create must not reach the server first). Single-flight: a drain
   * requested while one runs is dropped, since the running one will see the same queue.
   *
   * `showStatus` publishes the shared "draining" signal that status UI shows as "syncing". Only
   * a real reconnect sets it: writes go through the queue online too, and a near-instant
   * routine save shouldn't flash a sync banner.
   */
  drain = async (options: { showStatus?: boolean } = {}): Promise<void> => {
    if (this.running || !this.options.connectivity.isOnline()) return;
    this.running = true;
    const { queue } = this;
    try {
      const actions = (await queue.read<TAction>()).filter((a) => !queue.isStuck(a));
      if (actions.length === 0) return;
      const context = this.options.context();
      if (options.showStatus) queue.setDraining(true);
      this.log('drain start', { actions: actions.length });

      const succeeded = new Set<string>();
      attempts: for (const action of actions) {
        const outcome = await this.execute(action, context);
        this.log(outcome, { type: action.type, id: action.id });
        switch (outcome) {
          case 'success':
            await queue.remove(action.id);
            succeeded.add(action.type);
            queue.emitOutcome({
              action,
              outcome: 'success',
              isStuck: false,
              wasDeferred: action.attempts > 0 || this.now() - action.createdAt > (this.options.deferredThresholdMs ?? 5000),
            });
            break;
          case 'network':
            // Not a real attempt: leave the count alone, so a blip can never make an action
            // stuck. The connection is gone, so the rest would fail the same way; stop here and
            // let the reconnect drain carry on in order.
            break attempts;
          case 'failure':
            await queue.incrementAttempts(action.id);
            if (action.attempts + 1 >= queue.maxAttempts) await this.stuck(action, context);
            break;
          case 'terminal':
            // Retrying the same payload can only be rejected the same way. Dead-letter now
            // instead of one attempt per drain, which would leave the user's optimistic local
            // state ("queued") wrong until two more reconnects, for an outcome never in doubt.
            await queue.deadLetter(action.id);
            await this.stuck(action, context);
            break;
        }
      }

      // Each type's hook runs once, and a hook shared by several types runs once, too.
      const hooks = new Set([...succeeded].map((type) => this.handlers.get(type)?.afterDrain).filter((h) => h !== undefined));
      await Promise.all([...hooks].map((hook) => hook(context, actions).catch((e) => this.report(e, 'offline-driver: afterDrain'))));
      this.log('drain done', { succeeded: [...succeeded] });
    } catch (error) {
      this.report(error, 'offline-driver: drain');
    } finally {
      this.running = false;
      queue.setDraining(false);
    }
  };

  private execute = async (action: TAction, context: TContext) => {
    const handler = this.handlers.get(action.type);
    if (!handler) {
      // A handler missing (an action type removed in an update, with some still queued) is a
      // failure like any other: counted, then dead-lettered, never silently dropped.
      this.report(new Error(`No handler registered for action type "${action.type}"`), 'offline-driver: execute');
      return 'failure' as const;
    }
    try {
      return await handler.execute(action, context);
    } catch (error) {
      // Handlers should classify their own errors (see `attempt`); one that throws anyway is
      // treated as retryable, so a bug costs retries rather than the user's data.
      this.report(error, `offline-driver: ${action.type} threw`);
      return 'failure' as const;
    }
  };

  private stuck = async (action: TAction, context: TContext): Promise<void> => {
    try {
      await this.handlers.get(action.type)?.onStuck?.(action, context);
    } catch (error) {
      this.report(error, `offline-driver: ${action.type} onStuck`);
    }
    this.queue.emitOutcome({ action, outcome: 'failure', isStuck: true, wasDeferred: true });
  };

  private onOnline = async (): Promise<void> => {
    const wasOffline = this.offlineSince === null ? 0 : this.now() - this.offlineSince;
    this.offlineSince = null;
    // Stuck actions get one more chance per session, with whatever fixes the current build has.
    // Only once: reviving on every reconnect would loop forever (revive, fail ×3, stuck, revive…).
    if (!this.revived) {
      this.revived = true;
      const revived = await this.queue.reviveStuck();
      if (revived.length) this.log('revived stuck actions', { count: revived.length });
    }
    await this.drain({ showStatus: wasOffline >= (this.options.offlineThresholdMs ?? 2000) });
  };

  /**
   * Starts draining on its own: on reconnect, when new work is queued (debounced), and on
   * returning to the foreground. Returns a function that stops it. Run one per app.
   */
  start = (): (() => void) => {
    // Two running at once would race each other's offline bookkeeping. (React's StrictMode
    // starts, stops and starts again, which is fine: the stop comes first.)
    if (this.started) throw new Error('offline-driver: already started; start it once, at the app root');
    this.started = true;
    const { connectivity, lifecycle } = this.options;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (connectivity.isOnline()) void this.onOnline();
    else this.offlineSince = this.now();

    const stops = [
      connectivity.subscribe((online) => {
        if (!online) {
          this.offlineSince ??= this.now();
          return;
        }
        void this.onOnline();
      }),
      this.queue.onChange((change) => {
        if (change !== 'enqueue' && change !== 'replace') return;
        clearTimeout(timer);
        timer = setTimeout(() => void this.drain(), this.options.debounceMs ?? 500);
      }),
      lifecycle?.onForeground(() => void this.drain()) ?? (() => {}),
    ];
    return () => {
      clearTimeout(timer);
      stops.forEach((stop) => stop());
      this.started = false;
    };
  };
}
