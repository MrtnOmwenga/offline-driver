import type { Connectivity, Lifecycle, QueueStorage } from '../core';

/*
 * Adapters for React Native. Each takes the module it wraps as an argument rather than importing
 * it, so this package depends on none of them and they're swappable in tests:
 *
 *   import NetInfo from '@react-native-community/netinfo';
 *   import { AppState } from 'react-native';
 *   import AsyncStorage from '@react-native-async-storage/async-storage';
 */

interface NetInfoState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}
interface NetInfoModule {
  fetch(): Promise<NetInfoState>;
  addEventListener(listener: (state: NetInfoState) => void): () => void;
  configure?(config: { reachabilityUrl: string; reachabilityTest: (response: Response) => Promise<boolean> }): void;
}

/**
 * Connectivity from NetInfo, as "can reach the internet", not "has a network interface".
 *
 * `isConnected` turns true as soon as the radio joins a network, which can be a second or more
 * before requests actually work (no address yet, a captive portal). Draining then fails with
 * real network errors. So this prefers `isInternetReachable` and only falls back to
 * `isConnected` while reachability is still unknown. It starts offline until NetInfo's first
 * answer, so nothing fires in the moment before it knows.
 *
 * `reachabilityUrl`: NetInfo's default probe calls a Google endpoint, which is blocked in some
 * countries and on some networks, where the app would then read "offline" forever while every
 * real request works. Point it at your own API (a cheap endpoint answering 200) and reachability
 * means what the app depends on.
 */
export const netInfoConnectivity = (netInfo: NetInfoModule, options: { reachabilityUrl?: string } = {}): Connectivity & { dispose(): void } => {
  if (options.reachabilityUrl) {
    netInfo.configure?.({
      // A trailing slash on the base URL plus a leading one on the path gives "//", which many
      // servers 404: reachability would then read false for good.
      reachabilityUrl: options.reachabilityUrl.replace(/([^:]\/)\/+/g, '$1'),
      reachabilityTest: async (response) => response.status === 200,
    });
  }
  let online = false;
  const listeners = new Set<(online: boolean) => void>();
  const set = (state: NetInfoState) => {
    const next = state.isInternetReachable ?? state.isConnected ?? false;
    if (next === online) return;
    online = next;
    listeners.forEach((l) => l(online));
  };
  void netInfo.fetch().then(set, () => {});
  const dispose = netInfo.addEventListener(set);
  return {
    isOnline: () => online,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose,
  };
};

type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
interface AppStateModule {
  currentState: AppStateStatus | string | null;
  addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void };
}

/** Foregrounding from React Native's AppState: fires once each time the app becomes active again. */
export const appStateLifecycle = (appState: AppStateModule): Lifecycle => ({
  onForeground: (listener) => {
    let previous = appState.currentState;
    const subscription = appState.addEventListener('change', (next) => {
      if (next === 'active' && previous !== 'active') listener();
      previous = next;
    });
    return () => subscription.remove();
  },
});

/** AsyncStorage already has the shape the queue wants; this only narrows its type. */
export const asyncStorage = (storage: QueueStorage): QueueStorage => storage;

interface DirectoryConstructor {
  new (uri: string): { exists: boolean; list(): { uri: string }[] };
}

/**
 * The database files on disk, for `Databases`' `listFiles`:
 *
 *   import { Directory } from 'expo-file-system';
 *   import { defaultDatabaseDirectory } from 'expo-sqlite';
 *   listFiles: listDatabaseFiles(Directory, defaultDatabaseDirectory)
 *
 * Native only: on the web no real directory backs expo-sqlite, so leave `listFiles` out there.
 */
export const listDatabaseFiles =
  (Directory: DirectoryConstructor, databaseDirectory: string) => (): string[] => {
    // expo-sqlite gives a plain path; expo-file-system wants a file:// URI.
    const directory = new Directory(databaseDirectory.startsWith('file://') ? databaseDirectory : `file://${databaseDirectory}`);
    if (!directory.exists) return [];
    return directory.list().map((entry) => entry.uri.replace(/\/+$/, '').split('/').pop() ?? '');
  };
