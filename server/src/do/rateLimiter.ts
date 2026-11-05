import { DurableObject } from 'cloudflare:workers';

/** Sliding-window limiter, one instance per key (IP, device, org plugin endpoint…). */
export class RateLimiterDO extends DurableObject {
  async hit(limit: number, windowSec: number): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const hits = ((await this.ctx.storage.get<number[]>('h')) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) return { allowed: false, retryAfterSec: Math.ceil((windowMs - (now - hits[0])) / 1000) };
    hits.push(now);
    await this.ctx.storage.put('h', hits);
    return { allowed: true, retryAfterSec: 0 };
  }
}
