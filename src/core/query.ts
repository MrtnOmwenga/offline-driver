import { isNetworkError } from './errors';

/**
 * Merges a freshly fetched page into what's stored: fetched items replace stored ones with the
 * same key, stored items missing from the page are kept (it's a page, not the whole set), and
 * the result is sorted newest first. What "newest" means is the caller's: an order's createdAt
 * and an invoice's date are different fields, and guessing from common names gets one wrong.
 */
export const mergeBy = <T>({
  existing,
  fetched,
  getKey,
  getSortValue,
}: {
  existing: T[];
  fetched: T[];
  getKey: (item: T) => string;
  getSortValue: (item: T) => number;
}): T[] => {
  const byKey = new Map<string, T>();
  for (const item of existing) byKey.set(getKey(item), item);
  for (const item of fetched) byKey.set(getKey(item), item);
  return [...byKey.values()].sort((a, b) => getSortValue(b) - getSortValue(a));
};

/**
 * A query function that reads through a local cache: the network when it can, the cache when it
 * can't. Fits TanStack Query's `queryFn` or anything shaped like it.
 *
 * Known offline, it doesn't try the network at all. The request could only fail: fast on a
 * disconnected device, but only after the full timeout when the server is merely unreachable,
 * with a spinner on screen the whole time before showing the very same cache.
 *
 * A network error serves the cache quietly: offline is the expected case here, not a failure to
 * report. Any other error is thrown, so the caller's normal error handling sees it.
 */
export const offlineQuery =
  <T>({
    fromCache,
    fromNetwork,
    toCache,
    fallback,
    isOffline,
  }: {
    fromCache: () => T | null;
    fromNetwork: () => Promise<T>;
    toCache: (data: T) => void;
    /** What to return offline with nothing cached yet (an empty page, say). */
    fallback: T;
    isOffline?: () => boolean;
  }) =>
  async (): Promise<T> => {
    if (isOffline?.()) return fromCache() ?? fallback;
    try {
      const data = await fromNetwork();
      toCache(data);
      return data;
    } catch (error) {
      if (isNetworkError(error)) return fromCache() ?? fallback;
      throw error;
    }
  };
