import { z } from 'zod';
import type { ServerModule } from './modules.js';

const pingSchema = z.strictObject({});

/** Built-in module, always registered first. Owns the M1 request `ping` (spec §5.2): `{}` → `{ t: serverTime }`. */
export const coreModule: ServerModule = {
  name: 'core',
  handlers: {
    ping: (ctx, payload) => {
      pingSchema.parse(payload ?? {});
      return { t: ctx.now() };
    },
  },
};
