import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.js';

// What Admin shows as the installation's version, and whether its browser may look for a newer
// release. The server itself asks nobody: an installation behind a VPN only misses the line.

export const versionRoutes: FastifyPluginAsyncZod<{
  config: Pick<Config, 'build' | 'updateCheck'>;
}> = async (app, { config }) => {
  app.get(
    '/api/admin/version',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary:
          'The release and commit this server was built from, null for a development build, and whether Admin looks for a newer release',
        response: {
          200: z.object({
            version: z.string().nullable(),
            commit: z.string().nullable(),
            updateCheck: z.boolean(),
          }),
        },
      },
    },
    async () => ({ ...config.build, updateCheck: config.updateCheck }),
  );
};
