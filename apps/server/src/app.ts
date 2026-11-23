import { createDb } from '@agentome/db';
import swagger from '@fastify/swagger';
import { type KeyObject, randomBytes } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { AppError } from './errors.js';
import { writePlacesKey } from './places/keys.js';
import { proxyTrust } from './trusted-proxy.js';
import Fastify, { type FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { approvalRoutes } from './approvals/routes.js';
import { addSessionHooks, authRoutes, createAuth } from './auth.js';
import type { Config } from './config.js';
import { connectRoutes, loadWorkerBundle, WORKER_BUNDLE } from './connect.js';
import { connectionRoutes } from './connections/routes.js';
import { gitRoutes } from './git/routes.js';
import { apiTokenRoutes } from './api-tokens/routes.js';
import { manageRoutes, routeCatalog } from './mcp/manage.js';
import type { FetchLike } from './mcp/remote.js';
import { mcpRoutes } from './mcp/routes.js';
import { openapiOptions } from './openapi.js';
import { projectRoutes } from './projects/routes.js';
import { connectionsKey } from './connections/crypto.js';
import { addSecurityHeaders } from './headers.js';
import { pushRoutes } from './push/routes.js';
import { vapidKeys } from './push/service.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { knowledgeRoutes } from './knowledge/routes.js';
import { logContext, runWithLog } from './logs/context.js';
import { licenseRoutes } from './license/routes.js';
import { versionRoutes } from './routes/version.js';
import {
  keycloakAllowed,
  readOnlyGate,
  installationIdOf,
  useInstallation,
  useLicenseKey,
} from './license/service.js';
import { logRoutes } from './logs/routes.js';
import { modelConnectionRoutes } from './models/routes.js';
import { relayRoutes } from './models/relay.js';
import { type Launcher, placeLauncher as placeLauncherClient } from './places/client.js';
import { egressRoutes, fromEgressProxy, PROXY_KEY_HEADER } from './places/egress.js';
import { placeRoutes } from './places/routes.js';
import websocket from '@fastify/websocket';
import { scheduleRoutes } from './schedules/routes.js';
import { LogSink } from './logs/sink.js';
import { useSpanLogger } from './logs/span.js';
import { createJobs, type Jobs } from './jobs.js';
import { agentRoutes } from './routes/agents.js';
import { mcpLibraryRoutes } from './library/mcp.js';
import { skillRoutes } from './library/skills.js';
import { memoryRoutes } from './memory/routes.js';
import { healthRoutes } from './routes/health.js';
import { invitationRoutes } from './routes/invitations.js';
import { taskRoutes } from './routes/tasks.js';
import { teamRoutes } from './teams/routes.js';
import { userRoutes } from './routes/users.js';
import { runRoutes } from './runs/routes.js';
import { seatRoutes } from './seats/routes.js';
import { setupGate, setupRoutes } from './setup.js';
import { webApp } from './static.js';
import { webhookRoutes } from './webhooks/routes.js';

/**
 * Fastify's logger options: what a log line may never carry, and the request's trace, run and
 * seat on every line of it. With a sink, each line goes to stdout and to the sink.
 */
export const loggerOptions = (level: Config['logLevel'], sink?: LogSink) => ({
  level,
  // A copy: pino writes each line's own fields into the object the mixin returns, which would
  // otherwise be the request's context and carry them into every later line of the request.
  mixin: () => ({ ...logContext() }),
  ...(sink && {
    stream: {
      write(line: string) {
        process.stdout.write(line);
        sink.write(line);
      },
    },
  }),
  // No log line carries these today; the paths keep a future one from leaking them.
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    'password',
    '*.password',
    'token',
    '*.token',
  ],
  serializers: { req: requestForLog },
});

type BuildOptions = {
  workerBundle?: string;
  jobs?: Jobs;
  mcpFetch?: FetchLike;
  licenseKey?: KeyObject;
  placeLauncher?: Launcher;
  registryFetch?: FetchLike;
};

/**
 * `workerBundle` is for the tests, which give the server a bundle of their own or none. `jobs`
 * is the process's pg-boss, which main starts after the migrations; a test starts its own.
 * `mcpFetch` lets a test reach a library MCP server or a model connection on this machine,
 * which the gateway refuses. `placeLauncher` is the place launcher, a test's own or none. `registryFetch` stands
 * in for the image registries a project's services are pinned at. `licenseKey` is the public key a test signs its licenses against;
 * never the environment, which would be a way around the license.
 */
/** Calls one address may make to the API in a minute. */
const API_CALLS_A_MINUTE = 1200;

export async function buildApp(
  config: Config,
  {
    workerBundle = WORKER_BUNDLE,
    jobs = createJobs(config),
    mcpFetch,
    licenseKey,
    registryFetch,
    placeLauncher = config.placeLauncherUrl === undefined
      ? undefined
      : placeLauncherClient(config.placeLauncherUrl, config.secretKey),
  }: BuildOptions = {},
) {
  if (licenseKey) useLicenseKey(licenseKey);
  useInstallation(installationIdOf(config.secretKey));
  // The place launcher reads its key here: derived, never the installation's own.
  writePlacesKey(config.dataDir, config.secretKey);
  const sink = new LogSink();
  const proxy = proxyTrust(config.trustProxy);
  const app = Fastify({
    logger: loggerOptions(config.logLevel, sink),
    // A request's id is its trace's: unique across restarts, unlike Fastify's count.
    genReqId: () => randomBytes(8).toString('hex'),
    // Behind a reverse proxy, request.ip is the client's address from X-Forwarded-For: the
    // sign-in rate limit and the sessions' addresses depend on it.
    trustProxy: proxy.trust,
    // Requests Fastify rejects before routing (a malformed URL) get the same error format.
    frameworkErrors: errorHandler,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  // Before every other hook: each line of the request, in any of them, carries its trace.
  app.addHook('onRequest', (request, _reply, done) =>
    runWithLog(
      { traceId: request.id, route: `${request.method} ${pathForLog(request.url)}` },
      done,
    ),
  );
  useSpanLogger(app.log);
  addSecurityHeaders(app, { publicUrl: config.publicUrl, webDir: config.webDir });

  // Awaited before any route is added: the plugin documents routes as they are registered.
  await app.register(swagger, openapiOptions(config.build.version ?? 'development'));
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  const db = createDb(config.databaseUrl, (notice) => app.log.warn({ notice }, 'database notice'));
  // Bounded: a connection still trying to reach a database that is down would otherwise
  // keep shutdown waiting past the container's stop timeout.
  sink.attach(db);
  app.addHook('onClose', async () => {
    proxy.stop();
    await sink.close();
    await db.$client.end({ timeout: 5 });
  });
  const auth = createAuth(db, config, app.log);
  // A limit for every caller by address: a token or a session that leaked, or a run that holds
  // its token, cannot hammer the API. Generous, so that a person's tabs and a worker's events
  // never meet it; sign-in has its own, stricter one.
  // Before every other hook, the session's and the setup's among them: a caller past the limit
  // costs no database query.
  await app.register(rateLimit, { global: false });
  app.addHook(
    'onRequest',
    app.rateLimit({
      max: API_CALLS_A_MINUTE,
      timeWindow: 60_000,
      keyGenerator: (request) => request.ip,
      // The egress proxy asks for every place and run from one address: by its key, not counted.
      allowList: (request) =>
        request.url === '/health' ||
        request.url === '/ready' ||
        (request.url.startsWith('/api/egress/') &&
          fromEgressProxy(request.headers[PROXY_KEY_HEADER], config.secretKey)),
      errorResponseBuilder: (_request, context) =>
        new AppError(
          'rate_limited',
          `Too many requests from this address: try again in ${Math.ceil(context.ttl / 1000)} seconds`,
        ),
    }),
  );
  addSessionHooks(app, auth, db, config);
  app.addHook('onRequest', setupGate(db));
  // After the session hooks of each route: a read-only license refuses writes.
  app.addHook('preHandler', readOnlyGate(db));
  // Keycloak is Enterprise: set up on a Free installation it stays off, and says so.
  if (config.keycloak) {
    app.addHook('onReady', async () => {
      const allowed = await keycloakAllowed(db).catch((error: unknown) => {
        app.log.debug({ err: error }, 'the license could not be read at start');
        return true;
      });
      if (!allowed) {
        app.log.warn(
          'Keycloak is configured, but sign-in with Keycloak needs a license key: until an admin adds one in Admin → License, people sign in with their password',
        );
      }
    });
  }
  // Before any route: the management MCP builds its tools from the routes as they register.
  const catalog = routeCatalog(app);

  // Probes ask all the time (the image's HEALTHCHECK, compose, a load balancer): at info that
  // is two log lines per question.
  await app.register(healthRoutes, { db, logLevel: 'warn' });
  await app.register(authRoutes, {
    auth,
    publicUrl: config.publicUrl,
    keycloakAllowed: () => keycloakAllowed(db),
  });
  await app.register(setupRoutes, { db, auth, config });
  await app.register(userRoutes, { db, passwordSignIn: config.passwordSignIn });
  await app.register(invitationRoutes, {
    db,
    auth,
    publicUrl: config.publicUrl,
    passwordSignIn: config.passwordSignIn,
  });
  const bundle = loadWorkerBundle(workerBundle);
  const server = config.publicUrl.replace(/\/+$/, '');
  if (bundle) await app.register(connectRoutes, { bundle, server });
  await app.register(seatRoutes, {
    db,
    config,
    jobs,
    bundle: bundle?.sha256,
    placeLauncher,
  });
  await app.register(runRoutes, { db, jobs });
  await app.register(agentRoutes, { db, config });
  await app.register(memoryRoutes, { db });
  await app.register(skillRoutes, { db });
  await app.register(mcpLibraryRoutes, { db, config, fetchImpl: mcpFetch });
  await app.register(taskRoutes, { db, config });
  await app.register(teamRoutes, { db });
  await app.register(projectRoutes, {
    db,
    key: connectionsKey(config.secretKey),
    images: { registries: config.serviceRegistries, fetchImpl: registryFetch },
  });
  await app.register(knowledgeRoutes, { db, config });
  await app.register(connectionRoutes, { db, config });
  await app.register(modelConnectionRoutes, { db, config, fetchImpl: mcpFetch });
  await app.register(relayRoutes, { db, config, fetchImpl: mcpFetch });
  // WebSockets carry one thing: the terminal of a person's place. Its frames are keystrokes.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(placeRoutes, {
    db,
    launcher: placeLauncher,
    publicUrl: config.publicUrl,
    limits: config.placeLimits,
    computers: config.computers,
    secretKey: config.secretKey,
  });
  await app.register(egressRoutes, {
    db,
    secretKey: config.secretKey,
    publicUrl: config.publicUrl,
  });
  await app.register(scheduleRoutes, { db });
  await app.register(mcpRoutes, { db, config, jobs, fetchImpl: mcpFetch });
  await app.register(apiTokenRoutes, { db });
  await app.register(manageRoutes, {
    catalog,
    version: config.build.version ?? 'development',
  });
  await app.register(gitRoutes, { db, config });
  await app.register(approvalRoutes, { db });
  await app.register(pushRoutes, { db, vapid: vapidKeys(config.secretKey, config.publicUrl) });
  await app.register(webhookRoutes, { db, config, jobs });
  await app.register(logRoutes, { db });
  await app.register(licenseRoutes, { db });
  await app.register(versionRoutes, { config });
  // The image serves the built web app itself; in development Vite does.
  if (config.webDir !== undefined) await app.register(webApp, { root: config.webDir });

  return app;
}

// A path as a log line names it: no query, and a token in it (an invitation link) masked: long
// runs of URL-safe characters are tokens, ids are 36 with dashes.
const pathForLog = (url: string) => (url.split('?')[0] ?? '').replace(/[\w-]{40,}/g, '[redacted]');

// Fastify's own request serializer, with the path masked as above.
function requestForLog(request: FastifyRequest) {
  return {
    method: request.method,
    url: request.url.replace(/[\w-]{40,}/g, '[redacted]'),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}
