# offline-driver

Offline-first writes and reads for React Native. A durable outbox queue, a drain loop that knows a
dropped connection from a rejected request, and a synchronous SQLite layer for Expo.

Extracted from a production React Native app used by field staff on patchy mobile connections,
where "the request failed" has at least three different meanings and treating them the same loses
people's work.

```sh
npm install offline-driver
```

| Import | What | Needs |
|---|---|---|
| `offline-driver` | The queue, the driver, error classification, `offlineQuery`, `mergeBy`, the status store | nothing |
| `offline-driver/sqlite` | Databases by namespace and scope, a JSON key-value store, the web worker warm-up | expo-sqlite |
| `offline-driver/react` | `<OfflineProvider>`, `useOfflineStatus`, `useQueueOutcomes`, `useOfflineDriver` | React 18+ |
| `offline-driver/react-native` | Adapters for NetInfo, AppState and the database directory | the modules you pass in |

The core has no dependencies and runs anywhere (the tests run it in Node). The adapters take the
modules they wrap as arguments instead of importing them, so nothing here pins your versions of
React Native, Expo or NetInfo.

## Writing while offline

Every write goes through the queue, online or not. Online it drains within half a second, so
there's one code path, and it's the one that's tested every day rather than only in a tunnel.

```ts
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { attempt, OfflineDriver, Queue, type QueuedAction } from 'offline-driver';
import { appStateLifecycle, netInfoConnectivity } from 'offline-driver/react-native';

type CompleteTask = QueuedAction & { type: 'complete-task'; taskId: string; note: string };
type AddPhoto = QueuedAction & { type: 'add-photo'; taskId: string; uri: string };

export const driver = new OfflineDriver<CompleteTask | AddPhoto, { api: Api; queryClient: QueryClient }>({
  queue: new Queue({ storage: AsyncStorage }),
  connectivity: netInfoConnectivity(NetInfo, { reachabilityUrl: `${API_URL}/health` }),
  lifecycle: appStateLifecycle(AppState),
  context: () => ({ api, queryClient }),
  onError: (error, context) => Sentry.captureException(error, { tags: { context } }),
});

driver.register('complete-task', {
  // attempt() runs the request and classifies how it went.
  execute: (action, { api }) => attempt(() => api.completeTask(action.taskId, action.note)),
  // Once per drain, however many tasks were completed.
  afterDrain: async (_, { queryClient }) => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  // Dead-lettered: undo the optimistic "done" so the screen tells the truth.
  onStuck: (action, { queryClient }) => markTaskFailed(queryClient, action.taskId),
});

// In a screen, after updating the UI optimistically:
await driver.enqueue({ type: 'complete-task', taskId, note });
```

```tsx
// At the root: starts the driver for as long as it's mounted.
<OfflineProvider driver={driver}>
  <App />
</OfflineProvider>

// Anywhere: 'hidden' | 'offline' | 'syncing' | 'error' | 'success'
const status = useOfflineStatus();

// After the fact: "your change was saved" for work that waited, "couldn't save" for work that failed.
useQueueOutcomes((event) => {
  if (event.outcome === 'success' && !event.wasDeferred) return; // an ordinary instant save
  toast(event.outcome === 'success' ? 'Saved' : "Couldn't save a change");
});
```

On sign-out, call `driver.queue.clear()`: the queue isn't scoped to a user, and whatever's left
would otherwise drain under the next person's session.

## Reading while offline

```ts
import { offlineQuery, mergeBy } from 'offline-driver';
import { Databases, KvStore, kvTableSql } from 'offline-driver/sqlite';
import * as SQLite from 'expo-sqlite';

const dbs = new Databases({ sqlite: SQLite }).register('account', (db) => db.run(kvTableSql()));
const lastTasks = new KvStore<Page<Task>>((scope) => dbs.get('account', scope), 'tasks');

useQuery({
  queryKey: ['tasks', userId],
  queryFn: offlineQuery({
    fromCache: () => lastTasks.get(userId),
    fromNetwork: () => api.tasks(),
    toCache: (page) => lastTasks.set(page, userId),
    fallback: { items: [], total: 0 },
    isOffline: () => !driver.connectivity.isOnline(),
  }),
});
```

## How it decides

Every attempt ends in one of four outcomes, and each is handled differently:

| Outcome | What it means | What happens |
|---|---|---|
| `success` | Done | Removed; `afterDrain` hooks run once per drain |
| `network` | Never reached a server: no connection, a timeout, a reset | **Not counted as an attempt.** The drain stops, keeping the order, and resumes on reconnect |
| `failure` | Rejected, might work later: a 5xx, a 401, a 429, anything unknown | Counted. At three, dead-lettered and `onStuck` runs |
| `terminal` | Rejected and can't work later: a 4xx validation error | Dead-lettered at once |

The decisions behind that, each one learned the hard way:

- **A dropped connection isn't an attempt.** Otherwise three tunnels on a train journey are
  enough to lose someone's work. Only a server's answer counts toward the retry limit.
- **A validation error isn't retried.** The same payload can only be rejected the same way.
  Retrying it once per reconnect leaves the user's screen saying "queued" for hours about
  something that was never going to happen.
- **Recognising network errors is most of the work.** fetch, React Native and Axios each report a
  dead connection differently, and client SDKs often wrap the transport error in their own type
  with a made-up 500. `isNetworkError` checks names, codes and messages, and looks inside `cause`
  and `details`. A connection reset (`ECONNRESET`, a firewall cutting the connection mid-request)
  is the easy one to miss: miss it and resets get dead-lettered as server rejections.
- **The drain's own writes don't trigger drains.** New work drains after a 500 ms debounce, so a
  burst of taps coalesces first. But removing a sent action or counting a failed attempt must not
  schedule another drain, or a failing action burns all its retries in a second and a half
  instead of one per reconnect.
- **Stuck actions get one more chance per session.** On the first reconnect after launch, they're
  revived, so a fix shipped in an update can rescue them. Only once: reviving on every reconnect
  would loop forever.
- **Every write to the queue is serialised.** AsyncStorage has no transactions; two quick taps
  would both read the same snapshot and the second write would drop the first tap's action. A
  property test fires random bursts of concurrent writes and checks nothing is lost.
- **"Syncing" only after a real offline period.** Network libraries report offline for a moment
  at startup. Anything shorter than two seconds isn't a recovery, and routine online saves never
  show a banner.
- **Online means reachable.** NetInfo's `isConnected` turns true when the radio joins a network,
  before requests work (no address yet, a captive portal). The adapter prefers
  `isInternetReachable`. And NetInfo's default probe calls a Google endpoint, blocked in some
  countries and on some networks, where the app would read "offline" forever: point
  `reachabilityUrl` at your own API.

## SQLite: synchronous on purpose

The SQLite layer uses expo-sqlite's synchronous API only. An async version was tried and removed:
every `await` yields to the event loop, where a synchronous call elsewhere can interleave with it
on expo-sqlite's shared web worker and corrupt both results. Synchronous code can't be preempted.
A write too big for one synchronous transaction becomes several smaller ones.

- **A database that fails to open is closed.** Opening takes several synchronous round trips, and
  on a slow device one can time out. Left open and uncached, the handle keeps its lock on the
  file, and the retry races it. `Databases` closes it, so the retry starts clean.
- **Sign-out deletes what earlier sessions left.** `deleteNamespaces` removes the files opened
  this session and, given `listFiles`, the ones on disk from before: on a shared device the next
  person mustn't inherit the last one's data.
- **On the web, warm up the worker at boot.** expo-sqlite's web build starts its worker on first
  use, and a synchronous first call pays for that inside a busy-wait with a fixed budget, which
  times out on slow machines. Await `prewarmWebWorker(SQLite)` before rendering anything that
  reads a database.

## Developing

```sh
npm install
npm test          # vitest; SQLite runs against better-sqlite3 behind expo-sqlite's API
npm run typecheck
npm run build     # ESM + CJS + types, checked with publint and arethetypeswrong in CI
```

## License

MIT
