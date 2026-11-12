import { migrate } from '@agentome/db';
import { banner } from '@agentome/shared';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createJobs } from './jobs.js';
import { prepareInstallation } from './setup.js';

function readConfig() {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // The logger is configured from these very settings, so the message goes to stderr.
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

const config = readConfig();
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      try {
        await app?.close();
      } finally {
        process.exit(0);
      }
    })();
  });
}

try {
  const jobs = createJobs(config);
  app = await buildApp(config, { jobs });
  app.log.info('applying database migrations');
  await migrate(config.databaseUrl);
  await prepareInstallation(config, app.log);
  // A computer pairs by running the script at /connect and takes the worker and its checksum from
  // the same address: over plain HTTP, anyone on the way can hand it code of their own.
  const address = new URL(config.publicUrl);
  if (
    address.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)
  ) {
    app.log.warn(
      `${config.publicUrl} is plain HTTP: computers that connect download the worker unprotected. Give the server an HTTPS address before connecting laptops (deploy/OPERATIONS.md, HTTPS)`,
    );
  }
  // After the migrations: pg-boss installs its own schema, pgboss, on its first start.
  app.addHook('onClose', await jobs.start(app.log));
  await app.listen(config.listen);
  // Once it answers: the logs open with the name and where the server is.
  process.stdout.write(
    banner(`Agentome server is up at ${config.publicUrl}`, process.stdout.isTTY === true),
  );
} catch (error) {
  // Node's URL errors carry the URL they failed on, password included, as `input`.
  if (error instanceof Error) Reflect.deleteProperty(error, 'input');
  // A setting the operator has to fix is the whole message; anything else is a bug or an outage.
  if (app === undefined) process.stderr.write(`The server could not start: ${String(error)}\n`);
  else if (error instanceof ConfigError) app.log.fatal(error.message);
  else app.log.fatal({ err: error }, 'the server could not start');
  await app?.close();
  process.exit(1);
}
