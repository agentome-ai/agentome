import {
  ArtifactKind,
  ConnectionKind,
  GrantLevel,
  ModelConnectionKind,
  ToolDecision,
  RunStatus,
  SeatKind,
  TaskSource,
} from '@agentome/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Enums that the worker also needs come from @agentome/shared; the others exist only in the
// database.
export const runStatusEnum = pgEnum('run_status', RunStatus.enum);
export const seatKindEnum = pgEnum('seat_kind', SeatKind.enum);
export const grantLevelEnum = pgEnum('grant_level', GrantLevel.enum);
export const artifactKindEnum = pgEnum('artifact_kind', ArtifactKind.enum);
export const taskSourceEnum = pgEnum('task_source', TaskSource.enum);
export const connectionKindEnum = pgEnum('connection_kind', ConnectionKind.enum);
export const modelConnectionKindEnum = pgEnum('model_connection_kind', ModelConnectionKind.enum);
export const toolDecisionEnum = pgEnum('tool_decision', ToolDecision.enum);
export const userRoleEnum = pgEnum('user_role', ['admin', 'member']);
export const agentStatusEnum = pgEnum('agent_status', ['active', 'archived']);
export const engineEnum = pgEnum('engine', ['claude-code', 'codex']);
// Where an agent's runs go: its owner's computer under their subscription, or a server
// seat with a model connection's key.
export const agentRunsOnEnum = pgEnum('agent_runs_on', ['laptop', 'server']);
export const seatStatusEnum = pgEnum('seat_status', ['active', 'revoked']);
export const apiTokenScopeEnum = pgEnum('api_token_scope', ['read', 'write']);
export const taskStatusEnum = pgEnum('task_status', ['open', 'review', 'done']);
export const teamModeEnum = pgEnum('team_mode', ['auto', 'manual']);
export const projectIntakeEnum = pgEnum('project_intake', ['manual', 'auto']);
export const runStartedByEnum = pgEnum('run_started_by', ['user', 'cron', 'webhook', 'agent']);
export const catalogKindEnum = pgEnum('catalog_kind', ['skill', 'mcp', 'connector', 'template']);
export const catalogVisibilityEnum = pgEnum('catalog_visibility', ['org', 'private']);
export const webhookStatusEnum = pgEnum('webhook_status', ['received', 'processed', 'ignored']);
export const logSourceEnum = pgEnum('log_source', ['server', 'worker']);
export const notificationKindEnum = pgEnum('notification_kind', [
  'approval',
  'run_finished',
  'budget',
  'access',
  'comment',
]);

const id = () => uuid('id').primaryKey().defaultRandom();
const at = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => at('created_at').notNull().defaultNow();
const updatedAt = () =>
  at('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const fk = (name: string, column: () => AnyPgColumn) => uuid(name).references(column);
// better-auth's own rows go when their person does, and webhook deliveries with their
// connection, knowledge documents with their source, a person's sign-in to
// an MCP server with the person or the server; nothing else cascades.
const userFk = () =>
  uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

// better-auth reads and writes users, sessions, accounts and verifications through its
// Drizzle adapter, by the property names below.
export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    role: userRoleEnum('role').notNull().default('member'),
    // A disabled person cannot sign in, and their sessions are deleted.
    disabledAt: at('disabled_at'),
    // When the web app last said the person was there: a visible tab with recent input. Their
    // place on the server takes a run only while this is recent.
    presentAt: at('present_at'),
    // Required by better-auth. Nobody verifies an address: people join by invitation.
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // The unique index compares bytes, so Ann@x.com and ann@x.com would be two people.
  (t) => [check('users_email_lowercase', sql`${t.email} = lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: userFk(),
    token: text('token').notNull().unique(),
    expiresAt: at('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    userId: userFk(),
    // For email and password: provider "credential", the account id is the user id.
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: at('access_token_expires_at'),
    refreshTokenExpiresAt: at('refresh_token_expires_at'),
    scope: text('scope'),
    // The scrypt hash, never the password.
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('accounts_user_id_idx').on(t.userId)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: at('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

// One row, written when the setup completes: until it exists, the API answers
// setup_required.
export const installation = pgTable(
  'installation',
  {
    id: integer('id').primaryKey().default(1),
    orgName: text('org_name').notNull(),
    baseUrl: text('base_url').notNull(),
    setupCompletedAt: at('setup_completed_at').notNull().defaultNow(),
    // An HMAC of a fixed string under the secret key: the server refuses to start under
    // another key instead of silently losing everything signed with the old one.
    secretKeyFingerprint: text('secret_key_fingerprint').notNull(),
    // The license key an admin pasted, checked against the public key on
    // every read; empty while the installation is Free.
    license: text('license'),
    // The most active agents seen under the current key, for the soft limit; a new key resets it.
    licensePeakAgents: integer('license_peak_agents').notNull().default(0),
    // The latest time the server has seen: a clock put back does not bring a key back.
    licenseSeenAt: at('license_seen_at'),
  },
  (t) => [check('installation_single_row', sql`${t.id} = 1`)],
);

export const invitations = pgTable('invitations', {
  id: id(),
  // Only the hash: the link is shown once, to the admin who created it.
  tokenHash: text('token_hash').notNull().unique(),
  // Empty when whoever has the link may join with any address.
  email: text('email'),
  role: userRoleEnum('role').notNull(),
  createdBy: fk('created_by', () => users.id).notNull(),
  expiresAt: at('expires_at').notNull(),
  acceptedAt: at('accepted_at'),
  revokedAt: at('revoked_at'),
  createdAt: createdAt(),
});

export const catalogItems = pgTable(
  'catalog_items',
  {
    id: id(),
    kind: catalogKindEnum('kind').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    // A role template's settings or the text of a SKILL.md, depending on the kind.
    spec: jsonb('spec').notNull(),
    // Empty for items the platform ships, such as the built-in role templates.
    ownerUserId: fk('owner_user_id', () => users.id),
    visibility: catalogVisibilityEnum('visibility').notNull().default('org'),
    approvedBy: fk('approved_by', () => users.id),
    createdAt: createdAt(),
  },
  // The items the platform ships are known by kind and name: every start upserts them by it.
  (t) => [
    uniqueIndex('catalog_items_platform_name_idx')
      .on(t.kind, t.name)
      .where(sql`${t.ownerUserId} is null`),
  ],
);

export const agents = pgTable(
  'agents',
  {
    id: id(),
    // Exactly one owner, always a person. The owner also holds an `owner` grant, so access
    // is checked against agent_grants alone.
    ownerUserId: fk('owner_user_id', () => users.id).notNull(),
    name: text('name').notNull(),
    roleTitle: text('role_title').notNull(),
    instructions: text('instructions').notNull().default(''),
    engine: engineEnum('engine').notNull().default('claude-code'),
    modelPref: text('model_pref'),
    runsOn: agentRunsOnEnum('runs_on').notNull().default('laptop'),
    // On a server seat, the model comes from here and `model_pref` names one of its models.
    modelConnectionId: uuid('model_connection_id').references(
      (): AnyPgColumn => modelConnections.id,
      {
        onDelete: 'set null',
      },
    ),
    // A server run has no shell unless an admin allowed one: with a shell, the agent
    // could read the connection's key from its environment.
    serverShell: boolean('server_shell').notNull().default(false),
    // References to catalog items. Their shape belongs to the API that writes them, so the
    // database does not fix it.
    skills: jsonb('skills').$type<unknown[]>().notNull().default([]),
    tools: jsonb('tools').$type<unknown[]>().notNull().default([]),
    // Empty means the platform defaults apply.
    budget: jsonb('budget'),
    // Its owner let it go on past its monthly limit, for the month this falls in.
    budgetResumedAt: at('budget_resumed_at'),
    status: agentStatusEnum('status').notNull().default('active'),
    copiedFromAgentId: fk('copied_from_agent_id', (): AnyPgColumn => agents.id),
    templateId: fk('template_id', () => catalogItems.id),
    createdAt: createdAt(),
  },
  (t) => [index('agents_owner_user_id_idx').on(t.ownerUserId)],
);

// A team: agents that work in the runs of its lead, as subagents of the one `claude`
// process. An agent leads one team at most, so a run of it knows its team; it may be a
// member of several.
export const teams = pgTable('teams', {
  id: id(),
  name: text('name').notNull(),
  leadAgentId: fk('lead_agent_id', () => agents.id)
    .notNull()
    .unique(),
  // Auto lets the lead decide who works when; manual holds it to the steps.
  mode: teamModeEnum('mode').notNull().default('auto'),
  // Manual's order: [{ agents: member ids, note }].
  steps: jsonb('steps').$type<unknown[]>().notNull().default([]),
  createdBy: fk('created_by', () => users.id).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    agentId: fk('agent_id', () => agents.id).notNull(),
    // The order the lead reads its members in.
    position: integer('position').notNull(),
  },
  (t) => [unique().on(t.teamId, t.agentId), index('team_members_agent_id_idx').on(t.agentId)],
);

export const agentGrants = pgTable(
  'agent_grants',
  {
    id: id(),
    agentId: fk('agent_id', () => agents.id).notNull(),
    userId: fk('user_id', () => users.id).notNull(),
    level: grantLevelEnum('level').notNull(),
    validFrom: at('valid_from'),
    validUntil: at('valid_until'),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.agentId, t.userId), index('agent_grants_user_id_idx').on(t.userId)],
);

export const seats = pgTable(
  'seats',
  {
    id: id(),
    ownerUserId: fk('owner_user_id', () => users.id).notNull(),
    // The computer's hostname at pairing; the owner can rename it.
    name: text('name').notNull(),
    kind: seatKindEnum('kind').notNull(),
    engines: engineEnum('engines').array().notNull(),
    capabilities: jsonb('capabilities')
      // `worker`: the build the worker named at its last claim, the SHA-256 of its file.
      // `signedOut`: the engines that said at that claim that they are not signed in.
      .$type<{
        docker?: boolean;
        sandbox?: boolean;
        worker?: string;
        signedOut?: (typeof engineEnum.enumValues)[number][];
        // `platform`: the system the worker named at its last claim, Node's name for it.
        platform?: string;
      }>()
      .notNull()
      .default({}),
    // Only the hash is stored, so a database dump does not let anyone act as the seat.
    tokenHash: text('token_hash').notNull().unique(),
    lastSeenAt: at('last_seen_at'),
    status: seatStatusEnum('status').notNull().default('active'),
    // Minutes without keyboard or mouse after which the worker takes no runs, set
    // by the owner here and handed to the worker with every claim answer.
    idleMinutes: integer('idle_minutes').notNull().default(15),
    // Windows has no sandbox for an agent's commands: a Windows computer takes runs only after an
    // admin has allowed it to run them without one, which is when.
    sandboxWaivedAt: at('sandbox_waived_at'),
    // A person's place on the server: the project whose services it was made ready for, by the
    // hash of their approved list, and how far that got (PlaceShape in the server). Null when
    // nothing is running beside the agent; sleep clears it.
    placeShape: jsonb('place_shape'),
    // A revoked seat the owner took off the list; its runs still name it, so the row stays.
    removedAt: at('removed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('seats_owner_user_id_idx').on(t.ownerUserId)],
);

// The one-time code of "Connect a computer": it becomes a seat of the person who made it.
export const pairingCodes = pgTable('pairing_codes', {
  id: id(),
  // Only the hash: for its ten minutes the code is as good as a seat token.
  codeHash: text('code_hash').notNull().unique(),
  createdBy: fk('created_by', () => users.id).notNull(),
  expiresAt: at('expires_at').notNull(),
  usedAt: at('used_at'),
  createdAt: createdAt(),
});

// A project ties agents to the code hosts they may reach: an agent gets to
// a connection only through a project it is assigned to.
export const projects = pgTable('projects', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  goals: text('goals').notNull().default(''),
  // URLs under the project's code-host connections, the first being the main one: a Jira
  // issue's task gets it, and every run lists them all.
  repositories: text('repositories')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  // The team that takes the project's tasks: a task filed in the project, or an issue
  // of its Jira connection without an agent, goes to its lead. Auto: the lead takes it at once.
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  intake: projectIntakeEnum('intake').notNull().default('manual'),
  // Hosts the agents of its tasks may reach from a place on the server, besides Agentome and
  // the model vendors: names, `*.suffix` patterns or IP addresses. Empty is nothing more.
  allowedHosts: text('allowed_hosts')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  // What its main repository's devcontainer asks to run next to the agent in a place, as last
  // read (ProjectEnvironment in the server), and the fingerprint of the services an admin let
  // run. A place runs them only while the two agree.
  environment: jsonb('environment'),
  environmentApproved: text('environment_approved'),
  // What the runs of its tasks may cost in a calendar month; empty is no limit.
  usdPerMonth: numeric('usd_per_month'),
  // What its code hosts' webhooks start: the author agent fixes a failed pipeline or
  // addresses a review of its change request; a reviewer agent reviews people's.
  onPipelineFailed: boolean('on_pipeline_failed').notNull().default(false),
  onReview: boolean('on_review').notNull().default(false),
  reviewerAgentId: uuid('reviewer_agent_id').references((): AnyPgColumn => agents.id, {
    onDelete: 'set null',
  }),
  createdBy: fk('created_by', () => users.id).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projectAgents = pgTable(
  'project_agents',
  {
    projectId: fk('project_id', () => projects.id).notNull(),
    agentId: fk('agent_id', () => agents.id).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.projectId, t.agentId), index('project_agents_agent_id_idx').on(t.agentId)],
);

// An agent's recurring task: on these days of the week, at this minute in this zone, a
// task with this title and body is made and run. Days are 0 (Sunday) to 6, as Date.getDay().
export const schedules = pgTable(
  'schedules',
  {
    id: id(),
    agentId: fk('agent_id', () => agents.id).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    repository: text('repository'),
    days: integer('days').array().notNull(),
    // HH:MM, 24-hour, in `timeZone`.
    time: text('time').notNull(),
    timeZone: text('time_zone').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: at('last_run_at'),
    createdBy: fk('created_by', () => users.id).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('schedules_agent_id_idx').on(t.agentId)],
);

// Where a server run's model comes from: an admin's, as code-host connections are.
// The key is encrypted as their tokens are and never answered by the API.
export const modelConnections = pgTable('model_connections', {
  id: id(),
  name: text('name').notNull().unique(),
  kind: modelConnectionKindEnum('kind').notNull(),
  // The origin and any path in front of /v1, as the admin gave it: `https://openrouter.ai/api`.
  baseUrl: text('base_url').notNull(),
  keyCiphertext: text('key_ciphertext').notNull(),
  // The model ids its /v1/models answered at the last check: what an agent may pick from.
  models: jsonb('models').$type<string[]>().notNull().default([]),
  checkedAt: at('checked_at'),
  createdBy: fk('created_by', () => users.id).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projectConnections = pgTable(
  'project_connections',
  {
    id: id(),
    projectId: fk('project_id', () => projects.id).notNull(),
    // The one agent this token is for; empty for the project's shared connection. The gateway
    // takes an agent's own connection before the shared one. For Jira, the
    // agent its issues go to.
    agentId: fk('agent_id', () => agents.id),
    kind: connectionKindEnum('kind').notNull(),
    // The host and the namespace the connection reaches: for GitHub { owner }, for GitLab
    // { baseUrl, group }, for Jira { baseUrl, jql, statuses } with the filter as the
    // namespace. `host` and `namespace` repeat what config says, in the
    // form the resolver compares a repository URL against.
    config: jsonb('config').$type<Record<string, string>>().notNull(),
    host: text('host').notNull(),
    namespace: text('namespace').notNull(),
    // AES-256-GCM under a key derived from the secret key; never returned by the API.
    tokenCiphertext: text('token_ciphertext').notNull(),
    // Generated here and given to the host's webhook settings by the administrator.
    webhookSecretCiphertext: text('webhook_secret_ciphertext').notNull(),
    // The login the host reported for the token at the last successful test.
    accountLogin: text('account_login'),
    lastTestedAt: at('last_tested_at'),
    createdBy: fk('created_by', () => users.id).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('project_connections_project_id_idx').on(t.projectId),
    // One shared connection and at most one per agent for each place in a project: the
    // resolver's answer is unique. Nulls not distinct, so two shared ones collide too.
    unique().on(t.projectId, t.host, t.namespace, t.agentId).nullsNotDistinct(),
  ],
);

// Every webhook delivery a host made and the server accepted: the key that makes a
// repeat a no-op, and the audit of what came in. The body is not kept: it names people, and
// the processor needs a few fields of it, which travel in the job.
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => projectConnections.id, { onDelete: 'cascade' }),
    kind: connectionKindEnum('kind').notNull(),
    // X-GitHub-Delivery or X-Gitlab-Event-UUID.
    externalEventId: text('external_event_id').notNull(),
    // X-GitHub-Event or X-Gitlab-Event, as the host named it.
    event: text('event').notNull(),
    status: webhookStatusEnum('status').notNull(),
    receivedAt: at('received_at').notNull().defaultNow(),
    processedAt: at('processed_at'),
  },
  // Per connection: a connection with a secret of its own cannot take a neighbour's ids.
  (t) => [unique().on(t.connectionId, t.externalEventId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    agentId: fk('agent_id', () => agents.id).notNull(),
    // The project it was filed in, or whose Jira it came from; empty for one given to an agent.
    projectId: fk('project_id', () => projects.id),
    // The task whose agent assigned this one down to a lead under it.
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    source: taskSourceEnum('source').notNull(),
    // The issue key or event id in the source system; empty for manual tasks.
    externalRef: text('external_ref'),
    // What the source refused when the task reported back to it; empty once a later
    // report goes through.
    externalError: text('external_error'),
    // A URL or a local path the seat makes the run's workspace from.
    repository: text('repository'),
    status: taskStatusEnum('status').notNull().default('open'),
    createdBy: fk('created_by', () => users.id).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('tasks_agent_id_idx').on(t.agentId),
    index('tasks_project_id_idx').on(t.projectId),
    index('tasks_parent_task_id_idx').on(t.parentTaskId),
    // One task per Jira issue and agent, however often a poll finds it.
    uniqueIndex('tasks_jira_issue_idx')
      .on(t.agentId, t.externalRef)
      .where(sql`${t.source} = 'jira'`),
  ],
);

// A task's thread: a person's or an agent's comment, in markdown, only ever added. An
// agent's carries the run it wrote it in.
export const taskComments = pgTable(
  'task_comments',
  {
    id: id(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorUserId: fk('author_user_id', () => users.id),
    authorAgentId: fk('author_agent_id', () => agents.id),
    runId: fk('run_id', (): AnyPgColumn => runs.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('task_comments_task_id_idx').on(t.taskId)],
);

export const runs = pgTable(
  'runs',
  {
    id: id(),
    agentId: fk('agent_id', () => agents.id).notNull(),
    taskId: fk('task_id', () => tasks.id),
    // Empty while queued: the run goes to whichever eligible seat claims it first.
    seatId: fk('seat_id', () => seats.id),
    startedBy: runStartedByEnum('started_by').notNull(),
    // The person, when started_by is user.
    startedByUserId: fk('started_by_user_id', () => users.id),
    // Why a run nobody started by hand began: a failed pipeline, a review. The agent reads it.
    reason: text('reason'),
    // Changed only by claim, finish, cancel and the reaper, never by events.
    status: runStatusEnum('status').notNull().default('queued'),
    // Set when a seat claims the run, so queue time and run time can be told apart.
    startedAt: at('started_at'),
    endedAt: at('ended_at'),
    summary: text('summary'),
    // Why a run failed, as a code: orphaned, or whatever the seat reports.
    errorCode: text('error_code'),
    // The run token is issued with the launch package; only its hash is stored.
    tokenHash: text('token_hash').unique(),
    // Fixed at claim: the platform defaults overridden by the agent's budget.
    limits: jsonb('limits').$type<{ maxMinutes: number; maxTurns: number; maxTokens: number }>(),
    // A team run's members with their gateway tokens' hashes, and its steps.
    team: jsonb('team'),
    // The seat learns about a cancel from its next heartbeat or batch of events.
    cancelRequestedAt: at('cancel_requested_at'),
    // The reaper closes a running run whose seat has been silent too long.
    lastHeartbeatAt: at('last_heartbeat_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('runs_agent_id_idx').on(t.agentId),
    index('runs_task_id_idx').on(t.taskId),
    index('runs_seat_id_idx').on(t.seatId),
    // Every waiting claim reads the head of the queue once a second.
    index('runs_queued_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'queued'`),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: id(),
    runId: fk('run_id', () => runs.id).notNull(),
    // Numbered by the seat, so a batch that is sent again cannot duplicate events.
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.runId, t.seq)],
);

export const runArtifacts = pgTable(
  'run_artifacts',
  {
    id: id(),
    runId: fk('run_id', () => runs.id).notNull(),
    kind: artifactKindEnum('kind').notNull(),
    ref: text('ref').notNull(),
    meta: jsonb('meta').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('run_artifacts_run_id_idx').on(t.runId)],
);

// A person's own token for the management MCP and the API: like a seat token, only
// its hash is kept, and it acts as the person until revoked or expired. A disabled person's
// tokens stop with them, by the check on sign-in, not by a cascade.
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: id(),
    userId: fk('user_id', () => users.id).notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    // `read` passes only the requests that read; null never expires.
    scope: apiTokenScopeEnum('scope').notNull().default('write'),
    expiresAt: at('expires_at'),
    lastUsedAt: at('last_used_at'),
    revokedAt: at('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('api_tokens_user_id_idx').on(t.userId)],
);

// Every call an agent makes through the gateway, written before it runs: the audit
// of what the agent did, and the queue of what waits for its owner (decision = pending).
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: id(),
    runId: fk('run_id', () => runs.id).notNull(),
    // Repeats runs.agent_id: Approvals lists the pending calls of a person's agents.
    agentId: fk('agent_id', () => agents.id).notNull(),
    tool: text('tool').notNull(),
    // What the agent passed. No secret can be in it: a connection's token never reaches a tool.
    input: jsonb('input').notNull(),
    decision: toolDecisionEnum('decision').notNull(),
    // Why it was denied, in words the agent reads back.
    reason: text('reason'),
    decidedBy: fk('decided_by', () => users.id),
    decidedAt: at('decided_at'),
    // A line about what it did: the change request's address, the branch it made.
    outputSummary: text('output_summary'),
    createdAt: createdAt(),
  },
  (t) => [
    index('tool_calls_run_id_idx').on(t.runId),
    index('tool_calls_pending_idx')
      .on(t.agentId)
      .where(sql`${t.decision} = 'pending'`),
  ],
);

export const costEvents = pgTable(
  'cost_events',
  {
    id: id(),
    runId: fk('run_id', () => runs.id).notNull(),
    // Repeats runs.agent_id so that spend per agent needs no join.
    agentId: fk('agent_id', () => agents.id).notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    tokensIn: integer('tokens_in').notNull(),
    tokensOut: integer('tokens_out').notNull(),
    tokensCacheRead: integer('tokens_cache_read').notNull(),
    tokensCacheWrite: integer('tokens_cache_write').notNull(),
    // The part of tokens_cache_write cached for an hour, priced higher than five minutes.
    tokensCacheWrite1h: integer('tokens_cache_write_1h').notNull().default(0),
    // Empty when the price table has no price for the model.
    usd: numeric('usd'),
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('cost_events_run_id_idx').on(t.runId),
    index('cost_events_agent_id_idx').on(t.agentId),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: fk('user_id', () => users.id).notNull(),
    kind: notificationKindEnum('kind').notNull(),
    payload: jsonb('payload').notNull(),
    readAt: at('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_id_idx').on(t.userId)],
);

// A browser or phone where a person turned on notifications: the push service's
// endpoint and the keys its payloads are encrypted to. The endpoint is the device, so it is
// unique; a person signing in on someone's phone takes the row over.
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: id(),
    userId: fk('user_id', () => users.id).notNull(),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('push_subscriptions_user_id_idx').on(t.userId)],
);

// One row per version of a markdown document of an agent: the current document is
// the highest version of its path. A revert or a delete is a version too, so nothing is lost.
export const agentMemoryDocs = pgTable(
  'agent_memory_docs',
  {
    id: id(),
    agentId: fk('agent_id', () => agents.id).notNull(),
    // MEMORY.md or memory/<name>.md: where the document lands in a run's profile.
    path: text('path').notNull(),
    // Empty for a deleted document.
    content: text('content').notNull(),
    version: integer('version').notNull(),
    // Who wrote the version: a run of the agent or a person, never both.
    updatedByRunId: fk('updated_by_run_id', () => runs.id),
    updatedByUserId: fk('updated_by_user_id', () => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agent_memory_docs_version_idx').on(t.agentId, t.path, t.version)],
);

// Full-text search over knowledge: Postgres computes the vector, Drizzle only names it.
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

// Where a project's knowledge comes from: markdown under some paths of a connected repository,
// read through the code host's API. The last sync's error stays until one succeeds.
export const knowledgeSources = pgTable('knowledge_sources', {
  id: id(),
  projectId: fk('project_id', () => projects.id).notNull(),
  // { repository: URL, paths: ['README.md', 'docs'] }
  config: jsonb('config').notNull(),
  lastSyncAt: at('last_sync_at'),
  lastSyncError: text('last_sync_error'),
  createdAt: createdAt(),
});

// One markdown file of a source as of its last sync; `sha` is the host's id of its content, so
// a sync reads only what changed.
export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: id(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sha: text('sha').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    // The russian configuration stems Cyrillic words as Russian and Latin ones as English, so one
    // column finds the forms of both; a word in the title weighs more than one in the text.
    tsv: tsvector('tsv')
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('russian', title), 'A') || setweight(to_tsvector('russian', content), 'B')`,
      ),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('knowledge_documents_path_idx').on(t.sourceId, t.path),
    index('knowledge_documents_tsv_idx').using('gin', t.tsv),
  ],
);

// A person's sign-in to a library MCP server that uses OAuth: the gateway calls the
// server with the token of the agent's owner. While a sign-in is under way the row holds the
// hash of its state and the PKCE verifier; the tokens and the verifier are encrypted.
export const mcpAuthorizations = pgTable(
  'mcp_authorizations',
  {
    id: id(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => catalogItems.id, { onDelete: 'cascade' }),
    userId: userFk(),
    // { access_token, refresh_token?, token_type, scope? } as the server gave them, encrypted.
    tokens: text('tokens'),
    expiresAt: at('expires_at'),
    pendingState: text('pending_state'),
    pendingVerifier: text('pending_verifier'),
    pendingUntil: at('pending_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mcp_authorizations_server_user_idx').on(t.serverId, t.userId),
    uniqueIndex('mcp_authorizations_pending_state_idx').on(t.pendingState),
  ],
);

// A line of the server's or a worker's log, kept a month: its pino level, where it
// came from, its words and context without secrets, and the trace and run it belongs to. A line
// that timed some work (a request, a call to a code host or an MCP server) is a span. No foreign
// keys: a log outlives the run or seat it names, and writing it must never wait on them.
export const logEntries = pgTable(
  'log_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: at('at').notNull().defaultNow(),
    level: integer('level').notNull(),
    source: logSourceEnum('source').notNull(),
    message: text('message').notNull(),
    context: jsonb('context'),
    traceId: text('trace_id'),
    runId: uuid('run_id'),
    seatId: uuid('seat_id'),
    span: text('span'),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    index('log_entries_at_idx').on(t.at),
    index('log_entries_level_at_idx').on(t.level, t.at),
    index('log_entries_trace_id_idx').on(t.traceId),
    index('log_entries_run_id_idx').on(t.runId, t.at),
  ],
);
