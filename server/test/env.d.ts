import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as AppBindings } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppBindings {
      CENTRAL_MIGRATIONS: D1Migration[];
      ORG_MIGRATIONS: D1Migration[];
    }
  }
}
