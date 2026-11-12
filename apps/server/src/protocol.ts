import { engineEnum } from '@agentome/db';
import { ArtifactKind, ModelConnectionKind, RunStatus, SeatKind } from '@agentome/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

// What a seat sends and receives. The worker speaks the same JSON, with types of its own:
// it shares no code with the server.

const Engine = z.enum(engineEnum.enumValues);
// Token counts and seq numbers land in integer columns.
const Count = z.int().min(0).max(2_147_483_647);
export const Name = z.string().trim().min(1).max(100);
export const IdParams = z.object({ id: z.uuid() });
const Label = z.string().min(1).max(64);
const Payload = z.record(z.string(), z.unknown());

/** onSend hook: tokens and launch packages must not stay in any cache on the way. */
export async function noStore(_request: FastifyRequest, reply: FastifyReply) {
  reply.header('cache-control', 'no-store');
}

export const PairBody = z.object({
  code: z.string().max(64),
  name: Name,
  kind: SeatKind,
  engines: z.array(Engine).min(1).max(8),
  capabilities: z
    .object({ docker: z.boolean().optional(), sandbox: z.boolean().optional() })
    .default({}),
});

export const PairResponse = z.object({ seatId: z.uuid(), token: z.string() });

/** Engines in a query, comma-separated. */
const engineList = (least: number) =>
  z
    .string()
    .max(200)
    .transform((list) => list.split(',').filter((name) => name !== ''))
    .pipe(z.array(Engine).min(least).max(8))
    .optional();

export const ClaimQuery = z.object({
  wait: z.coerce.number().int().min(0).max(25).default(25),
  /**
   * The engines the worker finds on its computer now, comma-separated: a seat paired
   * before Codex was installed takes Codex runs once it is. Absent from an older worker.
   */
  engines: engineList(1),
  /**
   * Those of them that say they are not signed in: the seat gets no run of theirs, so
   * the runs wait in the queue instead of failing one after another.
   */
  signedOut: engineList(0),
  /**
   * Which build the worker is: the SHA-256 of its file, as `/connect` names the bundle.
   * Absent from a worker older than that.
   */
  worker: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /**
   * The worker's system, as Node names it: `win32` takes runs only once an admin allows the
   * computer to run without a sandbox. Absent from a worker older than that.
   */
  platform: z
    .string()
    .regex(/^[a-z0-9]{1,20}$/)
    .optional(),
});

export const RunLimits = z.object({ maxMinutes: z.int(), maxTurns: z.int(), maxTokens: z.int() });
export type RunLimits = z.infer<typeof RunLimits>;

export const LaunchPackage = z.object({
  run: z.object({ id: z.uuid(), token: z.string(), limits: RunLimits }),
  agent: z.object({
    id: z.uuid(),
    name: z.string(),
    roleTitle: z.string(),
    instructions: z.string(),
    engine: Engine,
    modelPref: z.string().nullable(),
    /** The agent's skills at their pinned versions; the worker puts them in the profile. */
    skills: z.array(z.object({ name: z.string(), version: z.int(), content: z.string() })),
    /** The agent's memory as it is at claim; the worker puts it in the profile. */
    memoryDocuments: z.array(z.object({ path: z.string(), version: z.int(), content: z.string() })),
  }),
  /**
   * A team run: the members the worker passes as subagents, each with its own gateway
   * server `agentome-<key>` opened by its own token, and the steps its hook on Agent holds the
   * lead to. Skills and memory go in the profile's team/<key>/. Absent when the agent leads none.
   */
  team: z
    .object({
      mode: z.enum(['auto', 'manual']),
      members: z.array(
        z.object({
          key: z.string(),
          agentId: z.uuid(),
          name: z.string(),
          description: z.string(),
          prompt: z.string(),
          modelPref: z.string().nullable(),
          token: z.string(),
          skills: z.array(z.object({ name: z.string(), version: z.int(), content: z.string() })),
          memoryDocuments: z.array(
            z.object({ path: z.string(), version: z.int(), content: z.string() }),
          ),
        }),
      ),
      steps: z.array(z.object({ members: z.array(z.string()), note: z.string() })),
    })
    .optional(),
  task: z
    .object({
      id: z.uuid(),
      title: z.string(),
      body: z.string(),
      repository: z.string().nullable(),
    })
    .nullable(),
  /**
   * A server seat's model: the agent's model connection, its key included. Only a
   * server seat gets it; a computer run is its owner's subscription and never sees a key.
   */
  model: z.object({ kind: ModelConnectionKind, baseUrl: z.string(), key: z.string() }).optional(),
  workspace: z.object({
    // The agent's tools: the run's token opens them, so only the address is here.
    mcp: z.object({ url: z.string() }),
    // The git proxy, when the task's repository is connected: clone and push go
    // here with the run's git password, which opens nothing else.
    git: z.object({ url: z.string(), username: z.string(), password: z.string() }).optional(),
    // In a person's place, the project's services running beside the agent, by the names it
    // reaches them at: the worker keeps calls to them off the egress proxy.
    services: z.array(z.string()).optional(),
    profile: z.object({
      claudeMd: z.string(),
      /** The task's project, for PROJECT.md; absent when the task has none. */
      projectMd: z.string().optional(),
      settings: z.object({
        permissionMode: z.literal('acceptEdits'),
        allowedTools: z.array(z.string()),
        // Claude Code's `sandbox` settings, as they go into the --settings file. Off on a server
        // seat, where the run's own container is the sandbox.
        sandbox: z.object({
          enabled: z.boolean(),
          failIfUnavailable: z.boolean(),
          autoAllowBashIfSandboxed: z.boolean(),
          allowUnsandboxedCommands: z.literal(false),
          network: z.object({
            allowedDomains: z.array(z.string()),
            strictAllowlist: z.literal(true),
            // Only for a server on the computer itself (launch.ts, networkFor).
            allowLocalBinding: z.literal(true).optional(),
          }),
        }),
      }),
    }),
  }),
});
export type LaunchPackage = z.infer<typeof LaunchPackage>;

// Stored as they come: the event schema and its fold belong to @agentome/shared.
export const EventsBody = z
  .array(
    z.object({
      seq: Count,
      type: Label,
      payload: Payload,
      at: z.iso.datetime({ offset: true }),
    }),
  )
  .max(500);

export const EventsResponse = z.object({ accepted: Count, cancelRequested: z.boolean() });

export const HeartbeatResponse = z.object({
  cancelRequested: z.boolean(),
  /** How long the run has stood waiting for its owner: the worker's time limit moves by it. */
  waitedMs: z.int().min(0),
});

export const FinishBody = z.object({
  status: RunStatus.extract(['done', 'failed', 'cancelled']),
  summary: z.string().max(20_000).optional(),
  errorCode: Label.optional(),
  artifacts: z
    .array(
      z.object({
        // Not `change_request`: the gateway records one when it opens it, and a seat that could
        // report one would tie its run to a request it did not open, whose merge closes the task.
        kind: ArtifactKind.exclude(['change_request']),
        ref: z.string().min(1).max(2000),
        meta: Payload.default({}),
      }),
    )
    .max(100)
    .default([]),
  usage: z
    .array(
      z
        .object({
          provider: Label,
          model: z.string().min(1).max(200),
          tokensIn: Count,
          tokensOut: Count,
          tokensCacheRead: Count,
          tokensCacheWrite: Count,
          // An older seat does not send it.
          tokensCacheWrite1h: Count.default(0),
          source: Label,
        })
        .refine((row) => row.tokensCacheWrite1h <= row.tokensCacheWrite, {
          message: 'tokensCacheWrite1h is a part of tokensCacheWrite',
          path: ['tokensCacheWrite1h'],
        }),
    )
    .max(100)
    .default([]),
});

export const FinishResponse = z.object({ status: RunStatus });
