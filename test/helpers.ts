import { memoryStorage, OfflineDriver, Queue, type ActionContext, type ActionOutcome, type QueuedAction } from '../src/core';

export const fakeConnectivity = (initial = true) => {
  let online = initial;
  const listeners = new Set<(online: boolean) => void>();
  return {
    isOnline: () => online,
    subscribe: (l: (online: boolean) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(value: boolean) {
      online = value;
      listeners.forEach((l) => l(value));
    },
  };
};

export type Note = QueuedAction & { type: 'note'; text: string };
export type Pin = QueuedAction & { type: 'pin'; noteId: string };
export type Action = Note | Pin;

/** A driver over memory storage whose "note" handler answers from a script of outcomes. */
export const setup = (options: { online?: boolean; outcomes?: ActionOutcome[]; now?: () => number } = {}) => {
  const storage = memoryStorage();
  const queue = new Queue({ storage, now: options.now });
  const connectivity = fakeConnectivity(options.online ?? true);
  const errors: [unknown, string][] = [];
  const driver = new OfflineDriver<Action, ActionContext & { user: string }>({
    queue,
    connectivity,
    context: () => ({ user: 'ada' }),
    onError: (error, context) => errors.push([error, context]),
    now: options.now,
  });
  const outcomes = [...(options.outcomes ?? [])];
  const executed: string[] = [];
  driver.register('note', {
    execute: async (action) => {
      executed.push(action.text);
      return outcomes.shift() ?? 'success';
    },
  });
  return { storage, queue, connectivity, driver, errors, executed, outcomes };
};
