import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.CENTRAL_DB, env.CENTRAL_MIGRATIONS);
await applyD1Migrations(env.ORG_DB, env.ORG_MIGRATIONS);
