import { HTTPException } from 'hono/http-exception';

export function fail(status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 501, code: string, extra?: Record<string, unknown>): never {
  throw new HTTPException(status, { res: Response.json({ error: code, ...extra }, { status }) });
}

export const now = () => Date.now();

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
