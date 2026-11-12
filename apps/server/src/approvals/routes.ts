import type { Db } from '@agentome/db';
import { ToolDecision } from '@agentome/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { approveForGood, decideToolCall } from '../mcp/policy.js';
import { IdParams, noStore } from '../protocol.js';
import { listApprovals } from './service.js';

const Approval = z.object({
  id: z.uuid(),
  tool: z.string(),
  // What the agent passed, as the gateway recorded it: the page words it for people.
  input: z.unknown(),
  runId: z.uuid(),
  agent: z.object({ id: z.uuid(), name: z.string() }),
  task: z.object({ id: z.uuid(), title: z.string(), repository: z.string().nullable() }).nullable(),
  createdAt: z.iso.datetime(),
});

// What stands after the request: the first decision wins, so it may not be this one.
const Decided = z.object({ decision: ToolDecision, reason: z.string().nullable() });

export const approvalRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.addHook('onRequest', app.requireSession);
  app.addHook('onSend', noStore);

  app.get(
    '/api/approvals',
    {
      schema: {
        summary: "Tool calls waiting for a decision on the person's agents, oldest first",
        response: { 200: z.object({ approvals: z.array(Approval) }) },
      },
    },
    async (request) => ({ approvals: await listApprovals(db, request.user.id) }),
  );

  app.post(
    '/api/tool-calls/:id/approve',
    {
      schema: {
        summary:
          "Lets a waiting tool call run; only the agent's owner decides. With always, the agent is not asked about that tool again",
        params: IdParams,
        body: z.object({ always: z.boolean().optional() }).nullish(),
        response: { 200: Decided },
      },
    },
    async (request) => {
      const call = { id: request.params.id, userId: request.user.id };
      return request.body?.always
        ? approveForGood(db, call)
        : decideToolCall(db, { ...call, decision: 'approved' });
    },
  );

  app.post(
    '/api/tool-calls/:id/answer',
    {
      schema: {
        summary: "Answers an agent's question (ask_owner); the agent reads the answer",
        params: IdParams,
        body: z.object({ answer: z.string().trim().min(1).max(4000) }),
        response: { 200: Decided },
      },
    },
    async (request) =>
      decideToolCall(db, {
        id: request.params.id,
        decision: 'approved',
        userId: request.user.id,
        reason: request.body.answer,
        answer: true,
      }),
  );

  app.post(
    '/api/tool-calls/:id/deny',
    {
      schema: {
        summary: 'Refuses a waiting tool call; the agent reads the reason',
        params: IdParams,
        body: z.object({ reason: z.string().trim().max(1000).optional() }).nullish(),
        response: { 200: Decided },
      },
    },
    async (request) =>
      decideToolCall(db, {
        id: request.params.id,
        decision: 'denied',
        userId: request.user.id,
        reason: request.body?.reason || undefined,
      }),
  );
};
