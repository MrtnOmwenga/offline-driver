import { describe, expect, it, vi } from 'vitest';
import { appStateLifecycle, listDatabaseFiles, netInfoConnectivity } from '../src/react-native';

describe('netInfoConnectivity', () => {
  const fakeNetInfo = () => {
    let listener: ((s: { isConnected: boolean | null; isInternetReachable: boolean | null }) => void) | undefined;
    return {
      emit: (isConnected: boolean | null, isInternetReachable: boolean | null) => listener?.({ isConnected, isInternetReachable }),
      module: {
        fetch: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
        addEventListener: vi.fn((l: typeof listener) => ((listener = l), () => (listener = undefined))),
        configure: vi.fn(),
      },
    };
  };

  it('starts offline, then trusts reachability over the interface being up', async () => {
    const netInfo = fakeNetInfo();
    const connectivity = netInfoConnectivity(netInfo.module);
    expect(connectivity.isOnline()).toBe(false);
    await vi.waitFor(() => expect(connectivity.isOnline()).toBe(true));
    const seen: boolean[] = [];
    connectivity.subscribe((online) => seen.push(online));
    netInfo.emit(true, false); // joined a network with no working route yet
    netInfo.emit(true, null); // reachability unknown: fall back to the interface
    netInfo.emit(false, null);
    expect(seen).toEqual([false, true, false]);
    connectivity.dispose();
  });

  it('points the reachability probe at your API, without a double slash', () => {
    const netInfo = fakeNetInfo();
    netInfoConnectivity(netInfo.module, { reachabilityUrl: 'https://api.example.com//health' });
    expect(netInfo.module.configure).toHaveBeenCalledWith(expect.objectContaining({ reachabilityUrl: 'https://api.example.com/health' }));
  });
});

it('appStateLifecycle fires on each return to the foreground only', () => {
  let listener: ((s: 'active' | 'background' | 'inactive') => void) | undefined;
  const remove = vi.fn();
  const lifecycle = appStateLifecycle({ currentState: 'active', addEventListener: (_, l) => ((listener = l), { remove }) });
  const onForeground = vi.fn();
  const stop = lifecycle.onForeground(onForeground);
  for (const state of ['inactive', 'active', 'active', 'background', 'active'] as const) listener!(state);
  expect(onForeground).toHaveBeenCalledTimes(2);
  stop();
  expect(remove).toHaveBeenCalled();
});

it('listDatabaseFiles turns the database directory into file names', () => {
  class Directory {
    exists = true;
    constructor(readonly uri: string) {}
    list = () => [{ uri: `${this.uri}/a.db` }, { uri: `${this.uri}/b.db-wal` }];
  }
  expect(listDatabaseFiles(Directory, '/data/SQLite')()).toEqual(['a.db', 'b.db-wal']);
});
