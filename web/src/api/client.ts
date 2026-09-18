import { platform } from '../platform/index.js';
import { noteServerTime } from './clock.js';

/**
 * The data layer.
 *
 * Every network call in the app goes through this file: plain `fetch`, plain
 * JSON, no framework. The rest of the frontend imports typed functions from
 * `api/*` and never constructs a URL, so auth, error shape and offline handling
 * are decided once, here.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the caller should send the user back to the invite screen. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

const TOKEN_KEY = 'token';

let token: string | null = platform.storage.get(TOKEN_KEY);
let unauthorizedHandler: (() => void) | null = null;

export function getToken(): string | null {
  return token;
}

export function setToken(value: string): void {
  token = value;
  platform.storage.set(TOKEN_KEY, value);
}

export function clearToken(): void {
  token = null;
  platform.storage.remove(TOKEN_KEY);
}

/** Lets the app shell bounce the user to the gate when a token goes stale. */
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

interface RequestOptions {
  body?: unknown;
  /** Raw payload for binary uploads; bypasses JSON encoding. */
  raw?: BodyInit;
  contentType?: string;
  signal?: AbortSignal;
}

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  // Remember which credential this request went out with. A 401 may arrive
  // after a *different* credential has been installed — the boot probe that
  // races a successful sign-in is the obvious case — and clearing the new
  // token because the old one was rejected would sign the user straight back
  // out.
  const sentWith = token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.contentType) headers['Content-Type'] = options.contentType;

  let response: Response;
  // Bracketing the request so the clock estimate knows how long it took — the
  // round trip is what bounds how much a server stamp can be trusted.
  const sentAt = Date.now();
  try {
    response = await fetch(`${platform.apiBaseUrl}${path}`, {
      method,
      headers,
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      // Sends the mirrored cookie when API and app share an origin. Harmless
      // cross-origin, where the bearer token above does the work.
      credentials: 'include',
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // `fetch` rejects with a deliberately opaque TypeError: a dropped
    // connection, a refused CORS preflight and a DNS failure are all the same
    // to script. Blaming the user's network for every one of them sends people
    // to check their wifi over a bug on our side, so only say that when the
    // browser itself reports being offline.
    throw navigator.onLine
      ? new ApiError(0, 'unreachable', 'Could not reach the server — please try again')
      : new ApiError(0, 'offline', 'No connection — check your network');
  }

  // Before the body is read: `text()` can take a while on a slow connection and
  // would inflate the round trip this sample is judged by.
  noteServerTime(response.headers.get('x-server-now'), sentAt, Date.now());

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? safeParse(text) : null;

  if (!response.ok) {
    const detail = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    const apiError = new ApiError(
      response.status,
      detail?.code ?? 'unknown',
      detail?.message ?? `Request failed (${response.status})`,
    );
    // A 401 means the credential *this request used* is dead; drop it so the
    // app cannot loop retrying with something that will never work. Only if it
    // is still the current one — see `sentWith`.
    if (apiError.isAuthError && token === sentWith) {
      clearToken();
      unauthorizedHandler?.();
    }
    throw apiError;
  }

  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const get = <T>(path: string, signal?: AbortSignal) =>
  request<T>('GET', path, { signal });
export const post = <T>(path: string, body?: unknown) => request<T>('POST', path, { body });
export const put = <T>(path: string, body?: unknown) => request<T>('PUT', path, { body });
export const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body });
export const del = <T>(path: string, body?: unknown) => request<T>('DELETE', path, { body });

/**
 * Fetch a binary resource with the same credentials as everything else.
 *
 * Payment screenshots live behind an authorized route, and an `<img src>`
 * cannot send a bearer token — so they are pulled down as blobs and handed to
 * `platform.objectUrl` instead.
 */
export async function getBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const headers: Record<string, string> = {};
  const sentWith = token;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${platform.apiBaseUrl}${path}`, {
    headers,
    credentials: 'include',
    signal,
  });

  if (!response.ok) {
    if (response.status === 401 && token === sentWith) {
      clearToken();
      unauthorizedHandler?.();
    }
    throw new ApiError(response.status, 'fetch_failed', 'Could not load that image');
  }
  return response.blob();
}
