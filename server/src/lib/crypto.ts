const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Uniform 6-digit code from a CSPRNG (rejection sampling, no modulo bias). */
export function randomDigits(n = 6): string {
  const max = 10 ** n;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % max).padStart(n, '0');
  }
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmac(secret: string, data: string): Promise<string> {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}

export async function sha256(data: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export interface JwtPayload {
  sub: string;
  dev: string;
  exp: number;
  iat: number;
  typ: 'access';
}

export async function signJwt(secret: string, payload: Omit<JwtPayload, 'iat' | 'exp' | 'typ'>, ttlSec: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({ ...payload, typ: 'access', iat: now, exp: now + ttlSec })));
  return `${header}.${body}.${await hmac(secret, `${header}.${body}`)}`;
}

export async function verifyJwt(secret: string, token: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = await hmac(secret, `${parts[0]}.${parts[1]}`);
  if (!timingSafeEqual(expected, parts[2])) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as JwtPayload;
    if (p.typ !== 'access' || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch {
    return null;
  }
}

/** Short-lived signed blob URL token (§7.2: R2 access through signed, short-lived URLs). */
export async function signBlobToken(secret: string, key: string, method: 'GET' | 'PUT', ttlSec: number, maxBytes = 0): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = b64url(enc.encode(JSON.stringify({ k: key, m: method, e: exp, s: maxBytes })));
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyBlobToken(secret: string, token: string, method: 'GET' | 'PUT'): Promise<{ key: string; maxBytes: number } | null> {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  if (!timingSafeEqual(await hmac(secret, payload), sig)) return null;
  const p = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { k: string; m: string; e: number; s: number };
  if (p.m !== method || p.e < Math.floor(Date.now() / 1000)) return null;
  return { key: p.k, maxBytes: p.s };
}

export function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : phone.slice(0, 4) + '*'.repeat(Math.max(0, phone.length - 7)) + phone.slice(-3);
}

/** Normalise Israeli/international numbers to E.164. Returns null if invalid. */
export function normalizePhone(raw: string): string | null {
  let p = raw.replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (/^0\d{8,9}$/.test(p)) p = '+972' + p.slice(1);
  if (/^972\d{8,9}$/.test(p)) p = '+' + p;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
