import { describe, expect, it } from 'vitest';
import { attempt, classifyError, isNetworkError, isNonRetryableStatus, serializeError } from '../src/core';

const withCode = (code: string, message = 'boom') => Object.assign(new Error(message), { code });

describe('isNetworkError', () => {
  it.each([
    ['fetch in React Native', new TypeError('Network request failed')],
    ['fetch in browsers', new TypeError('Failed to fetch')],
    ['Axios on Android', new Error('Network Error')],
    ['an Axios timeout', new Error('timeout of 30000ms exceeded')],
    ['an abort', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['a connection reset', withCode('ECONNRESET')],
    ['a broken pipe', withCode('EPIPE')],
    ['a socket hang up without a code', new Error('socket hang up')],
    ['a wrapped transport error in details', Object.assign(new Error('Request failed'), { status: 500, details: { code: 'ETIMEDOUT' } })],
    ['a wrapped transport error in cause', new Error('Request failed', { cause: withCode('ENOTFOUND') })],
  ])('recognises %s', (_, error) => expect(isNetworkError(error)).toBe(true));

  it.each([
    ['a server error', Object.assign(new Error('Internal Server Error'), { status: 500 })],
    ['a validation error', Object.assign(new Error('email is required'), { status: 422 })],
    ['a string', 'Network request failed'],
    ['null', null],
  ])('rejects %s', (_, error) => expect(isNetworkError(error)).toBe(false));
});

describe('classifyError', () => {
  it('retries what might succeed later, and not what cannot', () => {
    expect(isNonRetryableStatus(400)).toBe(true);
    expect(isNonRetryableStatus(422)).toBe(true);
    for (const status of [401, 403, 408, 429, 500, 503, undefined]) expect(isNonRetryableStatus(status)).toBe(false);
  });

  it('reads the status from the error or its Axios response', () => {
    expect(classifyError(Object.assign(new Error('x'), { status: 409 }))).toBe('terminal');
    expect(classifyError(Object.assign(new Error('x'), { response: { status: 404 } }))).toBe('terminal');
    expect(classifyError(Object.assign(new Error('x'), { status: 502 }))).toBe('failure');
    expect(classifyError(new Error('anything else'))).toBe('failure');
    expect(classifyError(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('takes a custom status reader', () => {
    expect(classifyError({ httpCode: 400 }, { getStatus: (e) => (e as { httpCode: number }).httpCode })).toBe('terminal');
  });
});

it('attempt turns a request into an outcome', async () => {
  expect(await attempt(async () => 'ok')).toBe('success');
  expect(await attempt(async () => Promise.reject(new TypeError('Failed to fetch')))).toBe('network');
  expect(await attempt(async () => Promise.reject(Object.assign(new Error('bad'), { status: 400 })))).toBe('terminal');
});

it('serializeError keeps the message JSON.stringify would drop', () => {
  const error = Object.assign(new Error('no such order'), { status: 404 });
  expect(JSON.stringify(error)).toBe('{"status":404}');
  expect(serializeError(error)).toMatchObject({ name: 'Error', message: 'no such order', status: 404 });
});
