import { API_URL } from '../config';
import { plainStore } from '../crypto/deviceKeys';

export class ApiError extends Error {
  constructor(public status: number, public code: string, public data: Record<string, unknown> = {}) {
    super(code);
  }
}

type Listener = (e: ApiError) => void;

let accessToken: string | null = null;
let accessExp = 0;
let refreshing: Promise<void> | null = null;
let currentOrg: string | null = null;
const fatalListeners = new Set<Listener>();

export const api = {
  setTokens(t: { accessToken: string; refreshToken: string; accessExpiresInSec: number }) {
    accessToken = t.accessToken;
    accessExp = Date.now() + (t.accessExpiresInSec - 30) * 1000;
    return plainStore.set('refresh', t.refreshToken);
  },
  async clearTokens() {
    accessToken = null;
    accessExp = 0;
    await plainStore.del('refresh');
  },
  setOrg(orgId: string | null) {
    currentOrg = orgId;
  },
  get org() {
    return currentOrg;
  },
  /** Listen for errors that require leaving the session or wiping an org (revocation, deactivation). */
  onFatal(l: Listener) {
    fatalListeners.add(l);
    return () => {
      fatalListeners.delete(l);
    };
  },
  async token(): Promise<string> {
    if (accessToken && Date.now() < accessExp) return accessToken;
    if (!refreshing) refreshing = doRefresh().finally(() => (refreshing = null));
    await refreshing;
    if (!accessToken) throw new ApiError(401, 'unauthenticated');
    return accessToken;
  },
  request,
  get: <T>(path: string, o?: Opts) => request<T>('GET', path, o),
  post: <T>(path: string, body?: unknown, o?: Opts) => request<T>('POST', path, { ...o, body }),
  put: <T>(path: string, body?: unknown, o?: Opts) => request<T>('PUT', path, { ...o, body }),
  patch: <T>(path: string, body?: unknown, o?: Opts) => request<T>('PATCH', path, { ...o, body }),
  del: <T>(path: string, o?: Opts) => request<T>('DELETE', path, o),
};

async function doRefresh() {
  const refreshToken = await plainStore.get('refresh');
  if (!refreshToken) return;
  const res = await fetch(`${API_URL}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
  if (!res.ok) {
    await api.clearTokens();
    const err = new ApiError(401, 'session_expired');
    fatalListeners.forEach((l) => l(err));
    return;
  }
  await api.setTokens(await res.json());
}

interface Opts {
  body?: unknown;
  raw?: BodyInit;
  auth?: boolean;
  org?: string | null;
  headers?: Record<string, string>;
}

async function request<T>(method: string, path: string, o: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.auth !== false) headers.authorization = `Bearer ${await api.token()}`;
  const org = o.org === undefined ? currentOrg : o.org;
  if (org && path.startsWith('/v1/') && !path.startsWith('/v1/me') && !path.startsWith('/v1/auth')) headers['x-org-id'] = org;
  let body = o.raw;
  if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body });
  } catch {
    throw new ApiError(0, 'offline');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = new ApiError(res.status, (data as { error?: string })?.error ?? `http_${res.status}`, (data as Record<string, unknown>) ?? {});
    if (res.status === 401 && err.code === 'device_revoked') fatalListeners.forEach((l) => l(err));
    if (res.status === 403 && (data as { wipe?: boolean })?.wipe) fatalListeners.forEach((l) => l(err));
    throw err;
  }
  return data as T;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
