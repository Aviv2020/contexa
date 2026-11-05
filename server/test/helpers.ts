import { exports } from 'cloudflare:workers';

export const BASE = 'https://api.contexa.test';
let counter = 0;

export async function call(method: string, path: string, opts: { token?: string; org?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.org) headers['x-org-id'] = opts.org;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await (exports as any).default.fetch(new Request(BASE + path, { method, headers, body }));
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

export function newDeviceId() {
  counter++;
  return `device-${Date.now()}-${counter}-xxxxxxxx`;
}

export async function login(phone: string, deviceId = newDeviceId(), ip = `10.0.0.${++counter % 250}`) {
  const r1 = await call('POST', '/v1/auth/otp/request', { body: { phone, deviceId }, headers: { 'cf-connecting-ip': ip } });
  if (r1.status !== 200) throw new Error(`otp request failed ${r1.status} ${JSON.stringify(r1.json)}`);
  const r2 = await call('POST', '/v1/auth/otp/verify', {
    body: { phone, deviceId, requestId: r1.json.requestId, code: r1.json.devCode, publicKey: `pk-${deviceId}`, platform: 'ios' },
    headers: { 'cf-connecting-ip': ip },
  });
  if (r2.status !== 200) throw new Error(`otp verify failed ${r2.status} ${JSON.stringify(r2.json)}`);
  return { ...r2.json, deviceId, token: r2.json.accessToken as string, userId: r2.json.user.id as string };
}
