/**
 * The base shape of anything the queue stores. The driver only ever touches these fields; an
 * app's own action union (with each type's payload) extends it. `type` is a plain string here so
 * the driver stays agnostic to which action types exist.
 */
export interface QueuedAction {
  id: string;
  type: string;
  attempts: number;
  createdAt: number;
}

/**
 * An action as the app queues it: the driver fills in the bookkeeping. Distributive, so a union
 * of action types stays a union (a plain `Omit` would collapse it to the fields they share).
 */
export type ActionDraft<T extends QueuedAction> = T extends unknown ? Omit<T, 'id' | 'attempts' | 'createdAt'> : never;

/**
 * How one attempt at an action ended:
 *
 * - `success`: done; the action leaves the queue.
 * - `network`: the request never reached a server (no connection, a timeout, a reset). This is
 *   not a real attempt: it doesn't count toward the retry limit, so a flaky connection can never
 *   make an action fail on its own.
 * - `failure`: a rejection that might succeed on retry (a 5xx, anything unclassified). Counts
 *   toward the retry limit.
 * - `terminal`: a rejection that can't succeed on retry (a 4xx validation error). Dead-lettered at
 *   once, instead of making the user wait through the remaining retries for a known outcome.
 */
export type ActionOutcome = 'success' | 'network' | 'failure' | 'terminal';

/** Whatever an app wants its handlers to receive: a query client, the signed-in user, … */
export type ActionContext = Record<string, unknown>;

export interface ActionHandler<TAction extends QueuedAction, TContext extends ActionContext> {
  /** Performs the action against the server and reports how it went. */
  execute: (action: TAction, context: TContext) => Promise<ActionOutcome>;
  /**
   * Runs once per drain in which at least one action of this type succeeded (not once per
   * action), with every action attempted in that drain, so a hook can look across types, e.g.
   * to refetch a list once after many queued edits. Optional.
   */
  afterDrain?: (context: TContext, drained: QueuedAction[]) => Promise<void>;
  /**
   * Runs once when this action is dead-lettered. The queue dropping it is generic bookkeeping;
   * anything the app wrote optimistically for it (a local row marked "queued") stays as it was
   * unless this hook updates it, and would otherwise read as "still syncing" forever. Optional.
   */
  onStuck?: (action: TAction, context: TContext) => Promise<void> | void;
}

/** Fired when an action reaches a definitive outcome: success, or dead-lettered. */
export interface QueueOutcomeEvent {
  action: QueuedAction;
  outcome: 'success' | 'failure';
  isStuck: boolean;
  /** It needed a retry, or sat queued for a while: "this was deferred", not "synced instantly". */
  wasDeferred: boolean;
}

/** Where errors worth reporting go (Sentry, a logger). The driver never throws them at you. */
export type ErrorReporter = (error: unknown, context: string) => void;
