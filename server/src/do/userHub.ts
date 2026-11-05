import { DurableObject } from 'cloudflare:workers';

/**
 * One instance per user: a single WebSocket per device that aggregates events from all of the
 * user's groups and orgs (§7.7). Uses the Hibernation API so idle connections cost nothing.
 * Events are nudges without content; the device then performs a delta sync.
 */
export class UserHubDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') === 'websocket') {
      const deviceId = req.headers.get('x-device-id') ?? 'unknown';
      // One socket per device: close older ones.
      for (const ws of this.ctx.getWebSockets(deviceId)) ws.close(4000, 'replaced');
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [deviceId]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/notify' && req.method === 'POST') {
      const body = await req.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(body);
        } catch {
          /* socket already gone */
        }
      }
      return new Response('ok');
    }
    if (url.pathname === '/disconnect' && req.method === 'POST') {
      const { deviceId } = (await req.json()) as { deviceId: string };
      for (const ws of this.ctx.getWebSockets(deviceId)) ws.close(4001, 'revoked');
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(): Promise<void> {
    // Clients only send pings (auto-responded). Read/typing events go through the batched HTTP API.
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, 'closing');
    } catch {
      /* already closed */
    }
  }
}
