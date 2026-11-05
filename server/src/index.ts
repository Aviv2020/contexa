import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Env } from './env';
import { requireAuth, requireOrg } from './middleware';
import auth from './routes/auth';
import me from './routes/me';
import groups from './routes/groups';
import messages from './routes/messages';
import keys from './routes/keys';
import files, { blob } from './routes/files';
import archive from './routes/archive';
import admin from './routes/admin';
import { runRetention } from './retention';
import { fail } from './lib/http';

export { OtpDO } from './do/otp';
export { UserHubDO } from './do/userHub';
export { RateLimiterDO } from './do/rateLimiter';

const app = new Hono<AppEnv>();

app.use('*', cors({ origin: () => null })); // mobile-only API; no browser origins (§1.4)
app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
  if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
});

app.get('/health', (c) => c.json({ ok: true, service: 'contexa-api' }));

app.route('/v1/auth', auth);
app.route('/v1/blob', blob);

app.use('/v1/me/*', requireAuth);
app.use('/v1/me', requireAuth);
app.route('/v1/me', me);

/** Single real-time channel per user (WebSocket to the user's Durable Object). */
app.get('/v1/ws', requireAuth, async (c) => {
  if (c.req.header('upgrade') !== 'websocket') fail(400, 'expected_websocket');
  const { userId, deviceId } = c.get('auth');
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-device-id', deviceId);
  return c.env.USER_HUB.get(c.env.USER_HUB.idFromName(userId)).fetch(new Request('https://hub/ws', { headers }));
});

// Org-scoped API: X-Org-Id header selects the active organisation.
const org = new Hono<AppEnv>();
org.use('*', requireAuth, requireOrg);
org.route('/', groups);
org.route('/', messages);
org.route('/', keys);
org.route('/', files);
org.route('/', archive);
org.route('/admin', admin);
app.route('/v1', org);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400);
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runRetention(env).then((r) => console.log('retention', r)));
  },
} satisfies ExportedHandler<Env>;
