import type { Env } from '../env';

/**
 * InforU is used for delivery only; Contexa generates and verifies codes itself (§3.5).
 * InforU automatically falls back to an IVR voice call for kosher numbers that cannot receive SMS.
 * NOTE: verify the request format against the InforU account's API docs before production.
 */
export async function sendSms(env: Env, phone: string, message: string): Promise<{ ok: boolean; channel: 'sms' | 'dev' }> {
  if (env.OTP_DEV_MODE === 'true') {
    console.log(`[dev sms] ${phone}: ${message}`);
    return { ok: true, channel: 'dev' };
  }
  if (!env.INFORU_USER || !env.INFORU_TOKEN) throw new Error('InforU credentials are not configured');
  const res = await fetch(env.INFORU_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + btoa(`${env.INFORU_USER}:${env.INFORU_TOKEN}`),
    },
    body: JSON.stringify({
      Data: {
        Message: message,
        Recipients: [{ Phone: phone.replace(/^\+972/, '0') }],
        Settings: { Sender: env.INFORU_SENDER },
      },
    }),
  });
  return { ok: res.ok, channel: 'sms' };
}
