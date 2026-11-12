import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import packageJson from '../../package.json' with { type: 'json' };
import { tokenScope } from '../auth.js';
import { AppError } from '../errors.js';
import { bearerToken } from '../tokens.js';

// The management MCP: the API's own routes as tools for a person's
// Claude Code, generated from the routes' schemas rather than written by hand, so a tool
// takes exactly what its route takes. Signed in with a personal token, it acts as the person.

/** The routes that become tools, by name: the whole surface of the MCP is this table. */
const TOOLS: Record<string, { name: string; readOnly: boolean }> = {
  'GET /api/agents': { name: 'list_agents', readOnly: true },
  'GET /api/agents/:id': { name: 'get_agent', readOnly: true },
  'GET /api/agents/:id/quality': { name: 'agent_quality', readOnly: true },
  'POST /api/agents': { name: 'create_agent', readOnly: false },
  'GET /api/agents/:id/export': { name: 'export_agent', readOnly: true },
  'POST /api/agents/import': { name: 'import_agent', readOnly: false },
  'PATCH /api/agents/:id': { name: 'update_agent', readOnly: false },
  'PUT /api/agents/:id/tools/:name': { name: 'set_tool_policy', readOnly: false },
  'PUT /api/agents/:id/tools': { name: 'set_tool_mode', readOnly: false },
  'POST /api/agents/:id/budget/resume': { name: 'resume_agent_budget', readOnly: false },
  // Who an agent belongs to: to a colleague for a vacation, to a successor for good.
  'GET /api/people': { name: 'list_people', readOnly: true },
  'POST /api/agents/:id/transfer': { name: 'transfer_agent', readOnly: false },
  'POST /api/users/:id/transfer-agents': { name: 'transfer_agents_of_person', readOnly: false },
  'GET /api/agents/:id/schedules': { name: 'list_schedules', readOnly: true },
  'POST /api/agents/:id/schedules': { name: 'add_schedule', readOnly: false },
  'PATCH /api/agents/:id/schedules/:scheduleId': { name: 'update_schedule', readOnly: false },
  'DELETE /api/agents/:id/schedules/:scheduleId': { name: 'remove_schedule', readOnly: false },
  'GET /api/projects': { name: 'list_projects', readOnly: true },
  'GET /api/tasks': { name: 'list_tasks', readOnly: true },
  'GET /api/tasks/:id': { name: 'get_task', readOnly: true },
  'POST /api/tasks': { name: 'create_task', readOnly: false },
  'PATCH /api/tasks/:id': { name: 'update_task', readOnly: false },
  'POST /api/tasks/:id/run': { name: 'run_task', readOnly: false },
  'POST /api/tasks/:id/comments': { name: 'comment_on_task', readOnly: false },
  'GET /api/runs': { name: 'list_runs', readOnly: true },
  'GET /api/runs/:id': { name: 'get_run', readOnly: true },
  'GET /api/runs/:id/events': { name: 'get_run_transcript', readOnly: true },
  'POST /api/runs/:id/cancel': { name: 'cancel_run', readOnly: false },
  'GET /api/templates': { name: 'list_templates', readOnly: true },
  'GET /api/projects/:id': { name: 'get_project', readOnly: true },
  'PATCH /api/projects/:id': { name: 'update_project', readOnly: false },
  'DELETE /api/projects/:id': { name: 'remove_project', readOnly: false },
  'PUT /api/projects/:id/agents/:agentId': { name: 'add_agent_to_project', readOnly: false },
  // Slice 4: memory, the library and knowledge. Adding or changing an MCP server is left to
  // the web app: its Authorization header is a secret, and a secret does not go through a
  // prompt.
  'GET /api/agents/:id/memory': { name: 'get_agent_memory', readOnly: true },
  'GET /api/agents/:id/memory/versions': { name: 'get_agent_memory_versions', readOnly: true },
  'PUT /api/agents/:id/memory': { name: 'write_agent_memory', readOnly: false },
  'POST /api/agents/:id/memory/revert': { name: 'revert_agent_memory', readOnly: false },
  'GET /api/library/skills': { name: 'list_skills', readOnly: true },
  'GET /api/library/skills/:id': { name: 'get_skill', readOnly: true },
  'POST /api/library/skills': { name: 'add_skill', readOnly: false },
  'POST /api/library/skills/:id/versions': { name: 'add_skill_version', readOnly: false },
  'POST /api/library/skills/:id/share': { name: 'share_skill', readOnly: false },
  'DELETE /api/library/skills/:id': { name: 'remove_skill', readOnly: false },
  'PUT /api/agents/:id/skills': { name: 'set_agent_skills', readOnly: false },
  'GET /api/library/mcp': { name: 'list_mcp_servers', readOnly: true },
  'POST /api/library/mcp/:id/check': { name: 'check_mcp_server', readOnly: false },
  'POST /api/library/mcp/:id/share': { name: 'share_mcp_server', readOnly: false },
  'DELETE /api/library/mcp/:id': { name: 'remove_mcp_server', readOnly: false },
  'PUT /api/agents/:id/mcp': { name: 'set_agent_mcp_servers', readOnly: false },
  // Teams as their own thing.
  'GET /api/teams': { name: 'list_teams', readOnly: true },
  'GET /api/teams/:id': { name: 'get_team', readOnly: true },
  'POST /api/teams': { name: 'create_team', readOnly: false },
  'PATCH /api/teams/:id': { name: 'update_team', readOnly: false },
  'POST /api/teams/:id/duplicate': { name: 'duplicate_team', readOnly: false },
  'DELETE /api/teams/:id': { name: 'remove_team', readOnly: false },
  'GET /api/projects/:id/knowledge': { name: 'list_knowledge_sources', readOnly: true },
  'POST /api/projects/:id/knowledge': { name: 'add_knowledge_source', readOnly: false },
  'POST /api/knowledge/:id/sync': { name: 'sync_knowledge_source', readOnly: false },
  'DELETE /api/knowledge/:id': { name: 'remove_knowledge_source', readOnly: false },
  'GET /api/approvals': { name: 'list_approvals', readOnly: true },
  'POST /api/tool-calls/:id/approve': { name: 'approve_tool_call', readOnly: false },
  'POST /api/tool-calls/:id/deny': { name: 'deny_tool_call', readOnly: false },
  'POST /api/tool-calls/:id/answer': { name: 'answer_question', readOnly: false },
  // Admin → Logs: reading only; the level is set in the web app.
  'GET /api/admin/logs': { name: 'list_logs', readOnly: true },
  'GET /api/admin/logs/traces/:id': { name: 'get_trace', readOnly: true },
  'GET /api/license': { name: 'get_license', readOnly: true },
  'PUT /api/admin/license': { name: 'set_license', readOnly: false },
  // Admin → Models: reading and checking only; a key is pasted in the web app, never
  // handed to Claude.
  'GET /api/model-connections': { name: 'list_model_connections', readOnly: true },
  'GET /api/models': { name: 'list_models', readOnly: true },
  'POST /api/model-connections/:id/check': { name: 'check_model_connection', readOnly: false },
};

type Shape = Record<string, z.ZodType>;
type Route = {
  method: string;
  url: string;
  summary: string;
  params: Shape;
  query: Shape;
  body: Shape;
};

/**
 * A field as the route receives it, before its own transforms and defaults: the tool hands the
 * raw value to the route, which parses it again, so a `before` that becomes an object or an
 * `all` that becomes a boolean must not be sent on as "[object Object]" or "true" twice over.
 */
function asReceived(field: z.ZodType): z.ZodType {
  if (field instanceof z.ZodPipe) return asReceived(field.in as z.ZodType);
  if (field instanceof z.ZodDefault) return asReceived(field.def.innerType as z.ZodType).optional();
  if (field instanceof z.ZodOptional) return asReceived(field.unwrap() as z.ZodType).optional();
  if (field instanceof z.ZodNullable) return asReceived(field.unwrap() as z.ZodType).nullable();
  return field;
}

/** The fields of a route's zod object schema, or none where the route has no such part. */
function shapeOf(schema: unknown): Shape {
  if (!(schema instanceof z.ZodObject)) return {};
  return Object.fromEntries(
    Object.entries(schema.shape as Shape).map(([key, field]) => [key, asReceived(field)]),
  );
}

/**
 * Collects the routes the table names as they are registered. Added to the root instance
 * before any route plugin: a route registered later still passes through it.
 */
export function routeCatalog(app: FastifyInstance): Map<string, Route> {
  const catalog = new Map<string, Route>();
  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      const key = `${method} ${route.url}`;
      if (!(key in TOOLS)) continue;
      const schema = (route.schema ?? {}) as Record<string, unknown>;
      catalog.set(key, {
        method,
        url: route.url,
        summary: typeof schema.summary === 'string' ? schema.summary : '',
        params: shapeOf(schema.params),
        query: shapeOf(schema.querystring),
        body: shapeOf(schema.body),
      });
    }
  });
  return catalog;
}

const title = (name: string) => name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export const manageRoutes: FastifyPluginAsync<{ catalog: Map<string, Route> }> = async (
  app,
  { catalog },
) => {
  /** One tool: its route called as the person, with the token that opened the MCP. */
  function handler(route: Route, authorization: string) {
    return async (args: Record<string, unknown>) => {
      let url = route.url;
      const query: Record<string, string> = {};
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (value === undefined) continue;
        if (key in route.params) url = url.replace(`:${key}`, encodeURIComponent(String(value)));
        else if (key in route.query) query[key] = String(value);
        else payload[key] = value;
      }
      const response = await app.inject({
        method: route.method as 'GET',
        url,
        query,
        payload: route.method === 'GET' ? undefined : payload,
        headers: { authorization, 'content-type': 'application/json' },
      });
      if (response.statusCode === 204)
        return { content: [{ type: 'text' as const, text: 'Done.' }] };
      if (response.statusCode >= 400) {
        const said = response.json<{ error?: { message?: string } }>().error?.message;
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: said ?? `The server answered ${response.statusCode}` },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response.json(), null, 2) }],
      };
    };
  }

  app.post('/mcp/manage', { schema: { hide: true } }, async (request, reply) => {
    // A personal token only: the browser's cookie stays with the web app.
    if (!bearerToken(request)) {
      throw new AppError('unauthorized', 'Sign in with a personal token (Account, API tokens)');
    }
    await app.requireSession(request);
    const authorization = request.headers.authorization ?? '';
    const server = new McpServer({ name: 'agentome-manage', version: packageJson.version });
    // A read-only token is refused every write anyway; it is not shown the tools that write.
    const readOnly = tokenScope(request) === 'read';
    for (const [key, tool] of Object.entries(TOOLS)) {
      const route = catalog.get(key);
      if (!route || (readOnly && !tool.readOnly)) continue;
      server.registerTool(
        tool.name,
        {
          title: title(tool.name),
          description: route.summary,
          inputSchema: z.object({ ...route.params, ...route.query, ...route.body }),
          annotations: {
            title: title(tool.name),
            readOnlyHint: tool.readOnly,
            destructiveHint: tool.name === 'cancel_run' || tool.name.startsWith('remove_'),
            openWorldHint: false,
          },
        },
        handler(route, authorization) as never,
      );
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

  const noSessions = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('allow', 'POST');
    throw new AppError('method_not_allowed', 'This MCP answers POST only: it keeps no sessions');
  };
  app.get('/mcp/manage', { schema: { hide: true } }, noSessions);
  app.delete('/mcp/manage', { schema: { hide: true } }, noSessions);
};
