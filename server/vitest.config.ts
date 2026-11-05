import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          OTP_DEV_MODE: 'true',
          JWT_SECRET: 'test-jwt-secret',
          OTP_HMAC_SECRET: 'test-otp-secret',
          BLOB_URL_SECRET: 'test-blob-secret',
          CENTRAL_MIGRATIONS: await readD1Migrations(path.join(__dirname, 'migrations/central')),
          ORG_MIGRATIONS: await readD1Migrations(path.join(__dirname, 'migrations/org')),
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
});
