import { DurableObject } from 'cloudflare:workers';
import { hmac, randomDigits, randomId, timingSafeEqual } from '../lib/crypto';

/**
 * One instance per phone number (§3.5): guarantees atomic attempt counting.
 * Only an HMAC-SHA256 of the code is stored, never the code itself.
 */
export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_MS = 60_000;
export const OTP_MAX_SENDS = 3;
export const OTP_SEND_WINDOW_MS = 15 * 60_000;

interface Pending {
  requestId: string;
  deviceId: string;
  hash: string;
  expiresAt: number;
  attempts: number;
}

export type OtpRequestResult = { ok: true; requestId: string; code: string } | { ok: false; error: 'resend_too_soon' | 'too_many_sends'; retryAfterSec: number };
export type OtpVerifyResult = { ok: true } | { ok: false; error: 'no_pending' | 'expired' | 'mismatch' | 'too_many_attempts' | 'wrong_device'; attemptsLeft?: number };

export class OtpDO extends DurableObject {
  async request(deviceId: string, secret: string): Promise<OtpRequestResult> {
    const now = Date.now();
    const sends = ((await this.ctx.storage.get<number[]>('sends')) ?? []).filter((t) => now - t < OTP_SEND_WINDOW_MS);
    const last = sends[sends.length - 1];
    if (last && now - last < OTP_RESEND_MS) return { ok: false, error: 'resend_too_soon', retryAfterSec: Math.ceil((OTP_RESEND_MS - (now - last)) / 1000) };
    if (sends.length >= OTP_MAX_SENDS) return { ok: false, error: 'too_many_sends', retryAfterSec: Math.ceil((OTP_SEND_WINDOW_MS - (now - sends[0])) / 1000) };

    const code = randomDigits(6);
    const requestId = randomId();
    const pending: Pending = { requestId, deviceId, hash: await hmac(secret, `${requestId}:${deviceId}:${code}`), expiresAt: now + OTP_TTL_MS, attempts: 0 };
    sends.push(now);
    await this.ctx.storage.put({ pending, sends });
    return { ok: true, requestId, code };
  }

  async verify(requestId: string, deviceId: string, code: string, secret: string): Promise<OtpVerifyResult> {
    const pending = await this.ctx.storage.get<Pending>('pending');
    if (!pending || pending.requestId !== requestId) return { ok: false, error: 'no_pending' };
    if (pending.deviceId !== deviceId) return { ok: false, error: 'wrong_device' };
    if (Date.now() > pending.expiresAt) {
      await this.ctx.storage.delete('pending');
      return { ok: false, error: 'expired' };
    }
    if (pending.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: 'too_many_attempts' };
    pending.attempts++;
    const candidate = await hmac(secret, `${requestId}:${deviceId}:${code}`);
    if (!timingSafeEqual(candidate, pending.hash)) {
      if (pending.attempts >= OTP_MAX_ATTEMPTS) {
        await this.ctx.storage.delete('pending');
        return { ok: false, error: 'too_many_attempts', attemptsLeft: 0 };
      }
      await this.ctx.storage.put('pending', pending);
      return { ok: false, error: 'mismatch', attemptsLeft: OTP_MAX_ATTEMPTS - pending.attempts };
    }
    await this.ctx.storage.delete('pending'); // single use
    return { ok: true };
  }
}
