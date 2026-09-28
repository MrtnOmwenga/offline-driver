/*
 * Telling a dropped connection from a rejected request. This matters more than it looks: a
 * network blip must not count as an attempt, or an action dies because the train went through a
 * tunnel; and a 4xx must not be retried, or the user waits through every retry for a rejection
 * that was never in doubt.
 */

const NETWORK_CODES = new Set([
  'ERR_NETWORK',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  // A connection reset mid-request rather than never established: the signature of something
  // in the path (a firewall's TCP RST) rather than a clean refusal. Easy to miss, and then a
  // reset is classified as a server rejection and dead-lettered instead of quietly retried.
  'ECONNRESET',
  'EPIPE',
]);

const NETWORK_MESSAGES = [
  'network request failed', // React Native's fetch
  'failed to fetch', // browsers
  'no internet',
  'network is unreachable',
  'timeout of', // Axios: "timeout of 30000ms exceeded"
  'request timed out',
  'econnrefused',
  'enotfound',
  'econnreset',
  'socket hang up', // Node/Axios when no code survives a reset
];

const codeOf = (value: unknown): string | undefined =>
  value && typeof value === 'object' ? ((value as { code?: unknown }).code as string | undefined) : undefined;

const messageOf = (value: unknown): string =>
  value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string'
    ? (value as { message: string }).message.toLowerCase()
    : '';

/**
 * Whether an error means the request never got an answer from a server. Recognises fetch,
 * React Native and Axios errors by name, code and message, and looks one level down into
 * `cause` / `details`, where client SDKs often keep the original transport error after wrapping
 * it in their own error type.
 */
export const isNetworkError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'NetworkError' || name === 'AbortError' || name === 'TimeoutError') return true;
  const message = messageOf(error);
  if (message === 'network error') return true; // Axios on Android
  if (NETWORK_CODES.has(codeOf(error) ?? '')) return true;
  if (NETWORK_MESSAGES.some((m) => message.includes(m))) return true;
  for (const inner of [(error as { cause?: unknown }).cause, (error as { details?: unknown }).details]) {
    if (inner && inner !== error && (NETWORK_CODES.has(codeOf(inner) ?? '') || NETWORK_MESSAGES.some((m) => messageOf(inner).includes(m)))) {
      return true;
    }
  }
  return false;
};

/**
 * Whether an HTTP status means retrying the same request can only fail the same way. Most 4xx
 * are, except: 401/403 (a token refresh may fix them before the next attempt), 408 (a server-side
 * timeout: a network symptom) and 429 (rate limiting: worth retrying later).
 */
export const isNonRetryableStatus = (status: number | undefined): boolean =>
  status !== undefined && status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);

const statusOf = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { status?: unknown; response?: { status?: unknown } };
  const status = typeof e.status === 'number' ? e.status : e.response?.status;
  return typeof status === 'number' ? status : undefined;
};

/** The outcome of a failed attempt, from its error: network, terminal (4xx) or failure. */
export const classifyError = (
  error: unknown,
  options: { getStatus?: (error: unknown) => number | undefined } = {},
): 'network' | 'failure' | 'terminal' => {
  if (isNetworkError(error)) return 'network';
  return isNonRetryableStatus((options.getStatus ?? statusOf)(error)) ? 'terminal' : 'failure';
};

/**
 * Runs a request and classifies how it went. For clients that throw on failure (fetch wrappers,
 * Axios). A client that returns errors instead of throwing can call `classifyError` directly.
 */
export const attempt = async (
  request: () => Promise<unknown>,
  options?: { getStatus?: (error: unknown) => number | undefined },
): Promise<'success' | 'network' | 'failure' | 'terminal'> => {
  try {
    await request();
    return 'success';
  } catch (error) {
    return classifyError(error, options);
  }
};

/**
 * `JSON.stringify(new Error('x'))` is `{}`: `message` isn't an own enumerable property. That's the
 * single most useful field when diagnosing why a request was rejected, so log this instead.
 */
export const serializeError = (error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error)) return { value: error };
  return {
    name: error.name,
    message: error.message,
    status: statusOf(error),
    code: codeOf(error),
  };
};
