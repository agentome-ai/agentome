import { z } from 'zod';

// Values shared by the database schema, the server and the worker. The database
// enums are generated from these lists, so adding a value here needs a migration.

/**
 * The app's name on the places' networks. Not `app` nor `agentome`: a way around a proxy names a
 * host there, and curl, git and Codex read the name as a domain's tail, so `app` also sent every
 * host in `.app` around it. No public domain ends in `.internal`. A place connects to the app by
 * it, over plain HTTP inside the installation.
 */
export const SERVER_NAME = 'agentome.internal';

export const RunStatus = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'done',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatus>;

// subscription-server: a person's own place on the company's server, their subscription in it,
// taking their agents' runs only while they are present.
export const SeatKind = z.enum([
  'subscription-laptop',
  'api-server',
  'local-model',
  'subscription-server',
]);
export type SeatKind = z.infer<typeof SeatKind>;

/** Only the owner's grant is in use; deputy, operator and viewer are kept for later. */
export const GrantLevel = z.enum(['owner']);
export type GrantLevel = z.infer<typeof GrantLevel>;

/** `change_request` is a GitLab merge request or a GitHub pull request. */
export const ArtifactKind = z.enum(['branch', 'change_request', 'file', 'report']);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const TaskSource = z.enum(['manual', 'jira', 'cron', 'webhook', 'chat', 'agent']);
export type TaskSource = z.infer<typeof TaskSource>;

/** What became of a tool call: `pending` waits for the agent's owner. */
export const ToolDecision = z.enum(['allowed', 'pending', 'approved', 'denied']);
export type ToolDecision = z.infer<typeof ToolDecision>;

/** The agent proposing its own instructions: the owner approves each time, never "allow". */
export const PROPOSE_INSTRUCTIONS = 'agent_propose_instructions';

/** The code hosts a connection may reach: the gateway, git proxy and webhooks take only these. */
export const CodeHostKind = z.enum(['github', 'gitlab']);
export type CodeHostKind = z.infer<typeof CodeHostKind>;
/** What a project connects to: a code host, or the Jira its tasks come from. */
export const ConnectionKind = z.enum([...CodeHostKind.options, 'jira']);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

/**
 * Where a server run's model comes from: Anthropic or OpenAI directly by an API key,
 * or a gateway that speaks both formats — LiteLLM, OpenRouter or another.
 */
export const ModelConnectionKind = z.enum(['anthropic', 'openai', 'gateway']);
export type ModelConnectionKind = z.infer<typeof ModelConnectionKind>;

export * from './banner.js';
export * from './run-events.js';
export * from './skill-files.js';
