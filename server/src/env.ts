import type { OtpDO } from './do/otp';
import type { UserHubDO } from './do/userHub';
import type { RateLimiterDO } from './do/rateLimiter';

export interface Env {
  CENTRAL_DB: D1Database;
  ORG_DB: D1Database;
  FILES: R2Bucket;
  CONFIG_KV: KVNamespace;
  OTP: DurableObjectNamespace<OtpDO>;
  USER_HUB: DurableObjectNamespace<UserHubDO>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiterDO>;
  APP_NAME: string;
  OTP_DEV_MODE: string;
  INFORU_SENDER: string;
  INFORU_API_URL: string;
  EXPO_PUSH_URL: string;
  JWT_SECRET: string;
  OTP_HMAC_SECRET: string;
  BLOB_URL_SECRET: string;
  INFORU_USER?: string;
  INFORU_TOKEN?: string;
}

export type Role = 'admin' | 'user';

export interface AuthCtx {
  userId: string;
  deviceId: string;
}

export interface OrgCtx {
  orgId: string;
  role: Role;
  mode: 'standalone' | 'connected';
}

export type AppEnv = {
  Bindings: Env;
  Variables: { auth: AuthCtx; org: OrgCtx };
};
