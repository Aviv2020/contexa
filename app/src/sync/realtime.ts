/** One WebSocket per user and device, multiplexing every group and org (§7.7). Reconnects with backoff. */
import { api } from '../api/client';
import { WS_URL } from '../config';
import { bus } from '../state/events';

export type HubEvent = { t: 'sync' | 'keys' | 'wipe'; orgId: string; groupId?: string; reason?: string };

export class Realtime {
  private ws: WebSocket | null = null;
  private retry = 0;
  private ping: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private onEvent: (e: HubEvent) => void) {}

  async connect() {
    this.closed = false;
    if (this.ws) return;
    let token: string;
    try {
      token = await api.token();
    } catch {
      return this.schedule();
    }
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      bus.emit('connection', { online: true });
      this.ping = setInterval(() => ws.readyState === ws.OPEN && ws.send('ping'), 25_000);
      this.onEvent({ t: 'sync', orgId: '*' }); // catch up after (re)connect
    };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') return;
      try {
        this.onEvent(JSON.parse(String(ev.data)));
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.ws = null;
      bus.emit('connection', { online: false });
      if (!this.closed) this.schedule();
    };
    ws.onerror = () => ws.close();
  }

  private schedule() {
    if (this.timer || this.closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
    this.ws = null;
  }
}
