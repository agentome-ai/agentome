import type { Db } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { applyLicense, licenseState } from './service.js';

// The license on Admin → License, and its state for every signed-in person's banner.

const Iso = z.iso.datetime();
const License = z.object({
  status: z.enum(['free', 'valid', 'grace', 'read_only']),
  enterprise: z.boolean(),
  installationId: z.string(),
  id: z.string().nullable(),
  company: z.string().nullable(),
  expiresAt: Iso.nullable(),
  graceEndsAt: Iso.nullable(),
  agents: z.object({
    limit: z.number().int().nullable(),
    active: z.number().int(),
    peak: z.number().int(),
  }),
  over: z.array(z.enum(['agents', 'teams', 'server_agents', 'budgets'])),
});

export const licenseRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    '/api/license',
    {
      onRequest: app.requireSession,
      schema: {
        summary:
          'The license: Free or Enterprise, whom a key is for and until when, the agents, where the installation is over Free, and whether it is read-only',
        response: { 200: License },
      },
    },
    async () => licenseState(db),
  );

  app.put(
    '/api/admin/license',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Puts a new license key in place; it works at once, without a restart',
        body: z.object({ key: z.string().trim().min(1, 'Paste the license key').max(4_000) }),
        response: { 200: License },
      },
    },
    async (request) => applyLicense(db, request.body.key),
  );
};
