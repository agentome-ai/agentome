import { tagLog } from '../logs/context.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  agents,
  and,
  type Db,
  eq,
  inArray,
  or,
  runArtifacts,
  runs,
  sql,
  tasks,
  toolCalls,
} from '@agentome/db';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import packageJson from '../../package.json' with { type: 'json' };
import { CodeHostError, type RepositoryRef } from '../code-host/index.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { connectionsKey } from '../connections/crypto.js';
import { codeHostOf, connectionFor } from '../connections/service.js';
import { isWorking } from '../runs/service.js';
import { bearerToken, hashSecret } from '../tokens.js';
import { notifyOwners } from '../push/service.js';
import { awaitDecision, ownPolicy, type Policy, policyFor } from './policy.js';
import { remoteFor, remoteToolName, serversOf } from '../library/mcp.js';
import { signOut } from '../library/mcp-oauth.js';
import {
  callRemoteTool,
  type FetchLike,
  guardedFetch,
  RemoteError,
  RemoteRefused,
} from './remote.js';
import {
  TOOLS,
  type Tool,
  type ToolContext,
  ToolRefusal,
  ASK_OWNER,
  ASSIGN_TASK,
  askOwner,
} from './tools.js';
import { memberOf, RunTeam } from '../agents/team.js';
import type { Jobs } from '../jobs.js';
import { issueOf, tellJira } from '../jira/push.js';
import { taskRepository } from '../tasks/repository.js';
import { assignTask } from '../tasks/subtasks.js';
import { reportsOf } from '../agents/team.js';
import { untrusted, untrustedResult } from './untrusted.js';

// POST /mcp: the agent's tools, opened by the run token while the run is live.
// Stateless: a server and a transport per request, answered on that request's own stream,
// which is where a waiting call's progress notifications go.

type Run = {
  id: string;
  /** The agent acting: the run's own, or the team member whose token made the call. */
  agentId: string;
  agentTools: unknown;
  /** Whose sign-in the acting agent's OAuth servers are called with. */
  agentOwnerId: string;
  /** The run's own agent, whose task and projects the code host comes from. */
  leadAgentId: string;
  team: unknown;
  repository: string | null;
  taskId: string | null;
};

/** The live run the token opens, with what its tools need; nothing for anything else. */
/** Whether an earlier run of the task already had its auto gate approved: one per task. */
async function gatePassed(db: Db, taskId: string | null): Promise<boolean> {
  if (!taskId) return false;
  const [passed] = await db
    .select({ id: toolCalls.id })
    .from(toolCalls)
    .innerJoin(runs, eq(runs.id, toolCalls.runId))
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(toolCalls.tool, 'team_step'),
        eq(toolCalls.decision, 'approved'),
        sql`${toolCalls.input}->>'gate' = 'true'`,
      ),
    )
    .limit(1);
  return passed !== undefined;
}

async function runOf(db: Db, token: string | undefined): Promise<Run | undefined> {
  const run = await findRun(db, token);
  if (run) tagLog({ runId: run.id });
  return run;
}

async function findRun(db: Db, token: string | undefined): Promise<Run | undefined> {
  if (!token) return undefined;
  const hash = hashSecret(token);
  const [run] = await db
    .select({
      id: runs.id,
      agentId: runs.agentId,
      agentTools: agents.tools,
      agentOwnerId: agents.ownerUserId,
      team: runs.team,
      repository: taskRepository,
      taskId: runs.taskId,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        or(
          eq(runs.tokenHash, hash),
          sql`${runs.team}->'members' @> ${JSON.stringify([{ tokenHash: hash }])}::jsonb`,
        ),
        // Not once Cancel, a revoked seat or the time limit stopped it, whatever its seat does.
        isWorking(),
      ),
    );
  if (!run) return undefined;
  const base = { ...run, leadAgentId: run.agentId };
  const member = memberOf(run.team, token);
  if (!member) return base;
  const [own] = await db
    .select({ tools: agents.tools, ownerId: agents.ownerUserId })
    .from(agents)
    .where(eq(agents.id, member.agentId));
  return {
    ...base,
    agentId: member.agentId,
    agentTools: own?.tools ?? [],
    agentOwnerId: own?.ownerId ?? base.agentOwnerId,
  };
}

/** What the agent reads when a tool cannot run: what happened and what to do. */
const refusal = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

export const mcpRoutes: FastifyPluginAsyncZod<{
  db: Db;
  config: Config;
  jobs: Pick<Jobs, 'fileJira' | 'filePush'>;
  fetchImpl?: FetchLike;
}> = async (app, { db, config, jobs, fetchImpl = guardedFetch }) => {
  const key = connectionsKey(config.secretKey);

  /** What a call works on; the task's code host only when a tool asks for it. */
  function contextOf(run: Run): ToolContext {
    return {
      db,
      agentId: run.agentId,
      runId: run.id,
      async codeHost() {
        const connection = await connectionFor(db, run.leadAgentId, run.repository);
        if (!connection) {
          throw new ToolRefusal(
            run.repository
              ? `This task's repository (${run.repository}) is not connected to a code host for any project of this agent. Ask an admin to connect it in Admin, Connections, and to put the agent on that project.`
              : 'This task has no repository, so there is no code host to act on.',
          );
        }
        const host = await codeHostOf(db, key, connection.id);
        const repository: RepositoryRef = await host.repository(run.repository ?? '');
        return { host, repository };
      },
      async jiraIssue() {
        const issue = run.taskId ? await issueOf(db, key, run.taskId) : null;
        if (!issue) throw new ToolRefusal('This task did not come from Jira, so it has no issue.');
        return issue;
      },
    };
  }

  type Extra = {
    signal: AbortSignal;
    _meta?: { progressToken?: string | number };
    sendNotification: (notification: never) => Promise<void>;
  };

  /**
   * One call, and whatever goes wrong in it that is not the host's doing: the SDK would hand
   * the error's own message to the agent (a failed query's text, say), so the agent reads a
   * sentence and the server log gets the error.
   */
  function handler(run: Run, tool: Tool, policy: Policy = policyFor(run.agentTools, tool.name)) {
    const call = callOf(run, tool, policy);
    return async (args: Record<string, unknown>, extra: Extra) => {
      try {
        return await call(args, extra);
      } catch (error) {
        app.log.error({ err: error, tool: tool.name, runId: run.id }, 'a gateway tool failed');
        return refusal(
          'Agentome could not run this tool. The error is in the server log; try again, or tell the agent’s owner if it keeps failing.',
        );
      }
    };
  }

  /** One call: recorded first, then decided by the policy, then run if it may. */
  function callOf(run: Run, tool: Tool, policy: Policy) {
    return async (args: Record<string, unknown>, extra: Extra) => {
      const decision = policy === 'allow' ? 'allowed' : policy === 'ask' ? 'pending' : 'denied';
      const reason = policy === 'deny' ? "This agent's policy does not allow this tool." : null;
      const [call] = await db
        .insert(toolCalls)
        .values({
          runId: run.id,
          agentId: run.agentId,
          tool: tool.name,
          input: args,
          decision,
          reason,
        })
        .returning({ id: toolCalls.id });
      if (!call) throw new Error('The insert returned no tool call');

      if (decision === 'denied') return refusal(`Denied: ${reason}`);
      if (decision === 'pending') {
        await db
          .update(runs)
          .set({ status: 'waiting_approval' })
          .where(and(eq(runs.id, run.id), eq(runs.status, 'running')));
        // Approvals lists the call either way: a lost notification must not leave it stuck.
        await notifyOwners(db, {
          id: call.id,
          runId: run.id,
          agentId: run.agentId,
          tool: tool.name,
        })
          .then(jobs.filePush)
          .catch((error: unknown) =>
            app.log.error({ err: error, runId: run.id }, 'the approval notification failed'),
          );
        const token = extra._meta?.progressToken;
        const outcome = await awaitDecision(db, {
          id: call.id,
          runId: run.id,
          signal: extra.signal,
          onProgress:
            token === undefined
              ? undefined
              : (waited) =>
                  extra.sendNotification({
                    method: 'notifications/progress',
                    params: {
                      progressToken: token,
                      progress: Math.round(waited / 1000),
                      message:
                        tool.name === ASK_OWNER
                          ? "Waiting for the agent's owner to answer"
                          : "Waiting for the agent's owner to approve this call",
                    },
                  } as never),
        });
        if (tool.name === ASK_OWNER) {
          // The owner's words are the result; Skip, or no answer in time, says so.
          if (outcome.decision !== 'approved') {
            const why = outcome.reason ? ` ${outcome.reason.replace(/([^.!?])$/, '$1.')}` : '';
            return refusal(
              `Your owner did not answer.${why} Go on with your best judgement and say so in your report.`,
            );
          }
          const answer = outcome.reason ?? '';
          await summarize(call.id, `Answered: ${answer}`);
          return { content: [{ type: 'text' as const, text: answer }] };
        }
        if (outcome.decision !== 'approved') {
          return refusal(`Denied: ${outcome.reason ?? "The agent's owner denied this call."}`);
        }
      }

      try {
        const result = await tool.run(contextOf(run), args as never);
        await summarize(call.id, result.summary);
        if (result.notify?.length) {
          await jobs
            .filePush(result.notify)
            .catch((error: unknown) =>
              app.log.error({ err: error, runId: run.id }, 'the comment notification failed'),
            );
        }
        if (result.changeRequest) {
          await db.insert(runArtifacts).values({
            runId: run.id,
            kind: 'change_request',
            ref: result.changeRequest.url,
            meta: {
              number: result.changeRequest.number,
              host: result.changeRequest.host,
              state: result.changeRequest.state,
            },
          });
          if (run.taskId) {
            const { url, title } = result.changeRequest;
            const job = { step: 'review', taskId: run.taskId, url, title } as const;
            await tellJira(db, jobs.fileJira, job, app.log);
          }
        }
        const answer = result.passThrough ?? {
          content: [{ type: 'text' as const, text: result.text }],
        };
        return result.from === undefined ? answer : untrustedResult(result.from, answer);
      } catch (error) {
        if (error instanceof ToolRefusal || error instanceof RemoteError) {
          await summarize(call.id, error.message);
          return refusal(error.message);
        }
        if (!(error instanceof CodeHostError)) throw error;
        // The host's own words, which carry no token, and its kind for the agent.
        const said = `${hostFailure(error.kind)}: ${error.message}`;
        await summarize(call.id, said);
        return refusal(`${hostFailure(error.kind)}:\n${untrusted('the code host', error.message)}`);
      }
    };
  }

  const summarize = (id: string, summary: string) =>
    db
      .update(toolCalls)
      .set({ outputSummary: summary.slice(0, 1000) })
      .where(eq(toolCalls.id, id));

  app.post('/mcp', { schema: { hide: true } }, async (request, reply) => {
    const run = await runOf(db, bearerToken(request));
    if (!run) throw new AppError('unauthorized', 'This run token is not valid, or the run ended');
    const server = new McpServer({ name: 'agentome', version: packageJson.version });
    server.registerTool(
      askOwner.name,
      {
        title: askOwner.title,
        description: askOwner.description,
        inputSchema: askOwner.input,
        annotations: { title: askOwner.title, readOnlyHint: true, openWorldHint: false },
      },
      handler(run, askOwner, 'ask') as never,
    );
    // A tool its owner denied is not listed: it would only fill the agent's context and its
    // tool search, to be refused if called.
    const denied = (name: string) => policyFor(run.agentTools, name) === 'deny';
    for (const tool of TOOLS) {
      if (denied(tool.name)) continue;
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input,
          annotations: {
            title: tool.title,
            readOnlyHint: tool.readOnly,
            destructiveHint: false,
            openWorldHint: true,
          },
        },
        handler(run, tool) as never,
      );
    }
    // A lead with leads under it hands them work down; a member's token never does.
    if (
      run.agentId === run.leadAgentId &&
      !denied(ASSIGN_TASK) &&
      (await reportsOf(db, run.agentId)).length > 0
    ) {
      server.registerTool(
        assignTask.name,
        {
          title: assignTask.title,
          description: assignTask.description,
          inputSchema: assignTask.input,
          annotations: { title: assignTask.title, readOnlyHint: false, openWorldHint: false },
        },
        handler(run, assignTask) as never,
      );
    }
    // The agent's library servers, from the tools each listed at its last check.
    for (const remote of await serversOf(db, run.agentTools)) {
      for (const listed of remote.spec.tools) {
        if (denied(remoteToolName(remote.name, listed.name))) continue;
        const tool: Tool = {
          name: remoteToolName(remote.name, listed.name),
          connector: remote.name,
          title: listed.title,
          description: listed.description,
          input: {},
          readOnly: false,
          async run(_context, args) {
            const target = await remoteFor(
              db,
              key,
              remote,
              run.agentOwnerId,
              fetchImpl,
              'Your owner has',
            );
            const answer = await callRemoteTool(target, listed.name, args, fetchImpl).catch(
              async (error: unknown) => {
                if (!(error instanceof RemoteRefused) || remote.spec.auth !== 'oauth') throw error;
                // A server may end a sign-in that its own renewal just extended (LiteLLM):
                // dropped here, the library shows Sign in instead of a sign-in that cannot work.
                await signOut(db, remote.id, run.agentOwnerId);
                throw new RemoteError(
                  `Your owner's sign-in to ${remote.name} has ended: they sign in again in Library, MCP servers, ${remote.name}.`,
                  { cause: error },
                );
              },
            );
            const text = answer.content
              .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
              .join('\n');
            return { text, summary: `${remote.name}: ${text}`, passThrough: answer, from: remote.name };
          },
        };
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: inputOf(listed.inputSchema),
            annotations: { title: tool.title, openWorldHint: true },
          },
          handler(run, tool) as never,
        );
      }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // A team run's hook on Agent asks here before an assignment: every one in auto,
  // the first of each step in manual. Recorded and decided like a tool call of the lead, so it
  // waits in Approvals by the lead's `team_step` policy, ask unless the owner set it: manual asks
  // at each step; auto asks once per task, at the `gate`, the first work after a member reported,
  // and lets its other assignments go.
  app.post(
    '/mcp/team-step',
    {
      schema: {
        hide: true,
        body: z.object({
          step: z.int().min(1).max(10).nullable(),
          members: z.array(z.string().max(40)).min(1).max(10),
          description: z.string().max(500).default(''),
          gate: z.boolean().default(false),
        }),
      },
    },
    async (request) => {
      const token = bearerToken(request);
      const run = await runOf(db, token);
      if (!run || !token) {
        throw new AppError('unauthorized', 'This run token is not valid, or the run ended');
      }
      const team = RunTeam.safeParse(run.team);
      if (!team.success || memberOf(run.team, token)) {
        throw new AppError('forbidden', "Only a team run's lead starts a step");
      }
      const { step, members, description, gate } = request.body;
      const called = members.map((key) => team.data.members.find((member) => member.key === key));
      if (called.some((member) => member === undefined)) {
        throw new AppError('validation_failed', 'Every agent of the step must be in the team');
      }
      // By name, for the owner's card in Approvals; the ids are what the record keeps.
      const named = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          inArray(
            agents.id,
            called.map((member) => member?.agentId ?? ''),
          ),
        );
      const tool: Tool = {
        name: 'team_step',
        connector: 'Team',
        title: 'Start a team step',
        description: '',
        input: {},
        readOnly: true,
        async run() {
          return { text: 'Go ahead.', summary: `Assigned ${members.join(', ')}` };
        },
      };
      const own = ownPolicy(run.agentTools, tool.name) ?? 'ask';
      const policy: Policy =
        team.data.mode === 'manual' || own === 'deny'
          ? own
          : !gate || (await gatePassed(db, run.taskId))
            ? 'allow'
            : own;
      const stop = new AbortController();
      request.raw.on('close', () => stop.abort());
      const result = await callOf(
        run,
        tool,
        policy,
      )(
        {
          step,
          members: called.map((member) => ({
            id: member?.agentId,
            name: named.find((agent) => agent.id === member?.agentId)?.name ?? member?.key,
          })),
          description,
          ...(gate && { gate: true }),
        },
        { signal: stop.signal, sendNotification: async () => undefined },
      );
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      return { allowed: !('isError' in result && result.isError), reason: text };
    },
  );

  // No sessions: nothing to listen to, nothing to close.
  const noSessions = async (_request: unknown, reply: FastifyReply) => {
    reply.header('allow', 'POST');
    throw new AppError(
      'method_not_allowed',
      'This gateway answers POST only: it keeps no sessions',
    );
  };
  app.get('/mcp', { schema: { hide: true } }, noSessions);
  app.delete('/mcp', { schema: { hide: true } }, noSessions);
};

/**
 * A server's JSON Schema as the SDK registers input: read into zod, so the agent sees the
 * server's own parameters; anything zod cannot read is passed on unchecked for the server to judge.
 */
/**
 * The schema a library server gave, without its defaults: zod would fill an omitted parameter
 * with the default before the call, and a server that declares `{ type: 'string', default:
 * null }` then refuses its own null ("None is not of type 'string'"). Its defaults are its own
 * to apply (seen with a Jira MCP server behind LiteLLM).
 */
function withoutDefaults(value: unknown, names = false): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutDefaults(item));
  if (value === null || typeof value !== 'object') return value;
  // Under `properties` the keys are parameter names, and a parameter may be called default.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => names || key !== 'default')
      .map(([key, inner]) => [key, withoutDefaults(inner, !names && key === 'properties')]),
  );
}

function inputOf(schema: Record<string, unknown>) {
  try {
    const read = z.fromJSONSchema(withoutDefaults(schema) as Record<string, unknown>);
    if (read instanceof z.ZodObject) return read;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  return z.looseObject({});
}

/** How the agent should read a host's failure, in a few words. */
function hostFailure(kind: CodeHostError['kind']): string {
  if (kind === 'unauthorized' || kind === 'forbidden') return 'The code host refused this token';
  if (kind === 'not_found') return 'Not found on the code host';
  if (kind === 'conflict') return 'The code host refused this as a conflict';
  if (kind === 'rate_limited') return 'The code host is rate limiting; try again later';
  if (kind === 'network' || kind === 'timeout') return 'The code host could not be reached';
  if (kind === 'unavailable') return 'The code host is failing; try again later';
  // A 400 and the like: the host is up and said no to this call, often in its own words.
  return 'The code host did not take this request';
}
