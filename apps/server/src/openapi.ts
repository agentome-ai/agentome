import type { FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

// The API's description at /openapi.json, and the reference on agentome.ai written from it: a
// section for every route by where its path starts, and who may call it.

type Section = { name: string; description: string };

const SECTIONS = {
  agents: {
    name: 'Agents',
    description:
      'Agents with their instructions, model, tools, skills, MCP servers, memory and recurring tasks.',
  },
  tasks: { name: 'Tasks', description: 'Tasks in projects, their comments and their runs.' },
  runs: { name: 'Runs', description: 'What a run did: its transcript, artifacts and cost.' },
  approvals: {
    name: 'Approvals',
    description: "Tool calls waiting for their owner's decision, and agents' questions.",
  },
  projects: {
    name: 'Projects',
    description:
      'Projects with their repositories, agents, knowledge and the services their runs need.',
  },
  teams: { name: 'Teams', description: 'A lead with members, and the order they work in.' },
  library: { name: 'Library', description: 'Skills and MCP servers people give their agents.' },
  connections: {
    name: 'Connections',
    description: 'GitLab, GitHub and Jira Data Center, with the webhooks they send.',
  },
  models: { name: 'Models', description: 'Model connections for agents that run on the server.' },
  computers: {
    name: 'Computers',
    description: "People's computers that run agents, connected with a pairing code.",
  },
  places: {
    name: 'Places',
    description: "The signed-in person's place on the server, where their agents run.",
  },
  you: {
    name: 'You',
    description: 'The signed-in person: their name, API tokens and notifications.',
  },
  people: { name: 'People', description: 'Accounts, invitations and handing work over.' },
  administration: {
    name: 'Administration',
    description: 'Logs, the license, the version and the first-run setup.',
  },
  health: { name: 'Health', description: 'For load balancers and monitoring; no sign-in.' },
  worker: {
    name: 'Worker',
    description:
      "What a computer's worker calls with its seat's or its run's token. Listed so the whole API is here; a script has no use for it.",
  },
} satisfies Record<string, Section>;

type Key = keyof typeof SECTIONS;

/** The worker's own calls: by a seat's or a run's token, never a person's. */
const WORKER = [
  /^POST \/api\/seats\/(pair|logs)$/,
  /^GET \/api\/seats\/claim$/,
  /^POST \/api\/runs\/\{id\}\/(events|heartbeat|finish)$/,
  /^(PUT|DELETE) \/api\/runs\/\{id\}\/container$/,
];

/** Calls made before anyone is signed in, or signed in another way. */
const PUBLIC = [
  /^GET \/(health|ready)$/,
  /^(GET|POST) \/api\/setup$/,
  /^(GET|POST) \/api\/invitations\/\{token\}(\/accept)?$/,
  /^POST \/api\/seats\/pair$/,
  /^GET \/api\/library\/mcp\/oauth\/callback$/,
  /^POST \/webhooks\//,
];

/** The section of a route by the start of its path; the more particular first. */
function sectionOf(method: string, url: string): Key {
  const route = `${method} ${url}`;
  if (WORKER.some((pattern) => pattern.test(route))) return 'worker';
  const rules: [RegExp, Key][] = [
    [/^\/(health|ready)$/, 'health'],
    [/^\/api\/me\/place/, 'places'],
    [/^\/api\/me/, 'you'],
    [/^\/api\/(users|people|invitations)/, 'people'],
    [/^\/api\/(admin|license|setup)/, 'administration'],
    [/^\/api\/(agents|templates)/, 'agents'],
    [/^\/api\/tasks/, 'tasks'],
    [/^\/api\/runs/, 'runs'],
    [/^\/api\/(approvals|tool-calls)/, 'approvals'],
    [/^\/api\/(projects|knowledge)/, 'projects'],
    [/^\/api\/teams/, 'teams'],
    [/^\/api\/library/, 'library'],
    [/^\/(api\/connections|webhooks)/, 'connections'],
    [/^\/api\/(model-connections|models)/, 'models'],
    [/^\/api\/seats/, 'computers'],
  ];
  const found = rules.find(([pattern]) => pattern.test(url));
  if (!found) throw new Error(`no section of the API reference for ${route}`);
  return found[1];
}

const DESCRIPTION = `Everything the Agentome web app does goes through this API, so a script can do it too: file
tasks, follow runs, decide approvals, set up agents and projects.

**Address.** Your installation's address with the paths below, such as
\`https://agentome.example.com/api/agents\`. Each server describes its own API at \`/openapi.json\`.

**Signing in.** Make a token in Agentome under your name, **API tokens**, and send it in the
\`Authorization\` header: \`Authorization: Bearer <token>\`. The token acts as you and can do what you
can, or only read if you made it that way. A few calls that handle secrets (tokens, keys, places,
notifications) answer only in the browser.

**Errors.** A refused call answers with its HTTP status and
\`{ "error": { "code": "not_found", "message": "…" } }\`; the message is written for a person.`;

/** The options of @fastify/swagger: the description, the sections and how to sign in. */
export function openapiOptions(version: string): FastifyDynamicSwaggerOptions {
  return {
    openapi: {
      info: { title: 'Agentome API', version, description: DESCRIPTION },
      servers: [
        {
          url: '{address}',
          description: 'Your installation',
          variables: { address: { default: 'https://agentome.example.com' } },
        },
      ],
      tags: Object.values(SECTIONS),
      components: {
        securitySchemes: {
          token: {
            type: 'http',
            scheme: 'bearer',
            description: 'A personal API token, made under your name, API tokens.',
          },
          session: {
            type: 'apiKey',
            in: 'cookie',
            name: 'agentome.session_token',
            description: "The web app's session, after signing in in the browser.",
          },
          seat: {
            type: 'http',
            scheme: 'bearer',
            description:
              "A seat's token, which a computer's worker gets when it connects, or a run's.",
          },
        },
      },
      security: [{ token: [] }, { session: [] }],
    },
    transform: (input) => {
      const { schema, url } = jsonSchemaTransform(input);
      if (input.schema.hide) return { schema, url };
      const method = String(
        Array.isArray(input.route.method) ? input.route.method[0] : input.route.method,
      );
      // Fastify's `:id`, as the description will write it.
      const path = url.replace(/:(\w+)/g, '{$1}');
      const route = `${method} ${path}`;
      const section = sectionOf(method, path);
      const security = PUBLIC.some((pattern) => pattern.test(route))
        ? []
        : section === 'worker'
          ? [{ seat: [] }]
          : undefined;
      return {
        url,
        schema: {
          ...schema,
          tags: [SECTIONS[section].name],
          ...(security ? { security } : {}),
        },
      };
    },
  };
}
