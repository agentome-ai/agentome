# Configuration

Agentome reads its settings from environment variables. Every setting has a default, so a
fresh install needs no `.env` file. An empty value counts as unset.

## Server settings

| Variable                             | Purpose                                                                                                                                                                                                                                        | Default                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `AGENTOME_DATABASE_URL`              | PostgreSQL 16 connection string (`postgres://` or `postgresql://`)                                                                                                                                                                             | `postgres://agentome:agentome@localhost:5432/agentome`                      |
| `AGENTOME_DATABASE_URL_FILE`         | File that holds the connection string, for Docker secrets; surrounding whitespace is ignored                                                                                                                                                   | None                                                                        |
| `AGENTOME_LISTEN`                    | Address and port the server listens on, `host:port`; an IPv6 host in brackets, `[::]:3000`                                                                                                                                                     | `0.0.0.0:3000`                                                              |
| `AGENTOME_PUBLIC_URL`                | Address at which people and seats reach the server, `http://` or `https://`, without a path                                                                                                                                                    | `http://localhost:3000`                                                     |
| `AGENTOME_OAUTH_RETURN_URL`          | Address an MCP server's sign-in returns the browser to, when its authorization server takes only some, such as `http://localhost:3100` on the machine that runs Agentome; on a localhost address the sign-in names the person, not the session | `AGENTOME_PUBLIC_URL`                                                       |
| `AGENTOME_DATA_DIR`                  | Directory for the files the server keeps on disk, such as `secrets/secret.key`                                                                                                                                                                 | `./.data`, relative to the working directory; the Docker image sets `/data` |
| `AGENTOME_SECRET_KEY`                | Key the server signs and encrypts its data with; at least 32 characters                                                                                                                                                                        | Generated on the first start (see below)                                    |
| `AGENTOME_SECRET_KEY_FILE`           | File that holds the secret key, for Docker secrets; surrounding whitespace is ignored                                                                                                                                                          | None                                                                        |
| `AGENTOME_WEB_DIR`                   | Directory with the built web app (`index.html` and `assets/`), which the server then serves                                                                                                                                                    | None, so Vite serves it in development; the Docker image sets `/app/web`    |
| `AGENTOME_LOG_LEVEL`                 | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                                                                                                                                                 | `info`                                                                      |
| `AGENTOME_RUN_MAX_MINUTES`           | Longest a run may last, in minutes, unless the agent's budget sets its own                                                                                                                                                                     | `60`                                                                        |
| `AGENTOME_RUN_MAX_TURNS`             | Most turns a run may take, unless the agent's budget sets its own                                                                                                                                                                              | `50`                                                                        |
| `AGENTOME_RUN_MAX_TOKENS`            | Most tokens a run may use, unless the agent's budget sets its own                                                                                                                                                                              | `2000000`                                                                   |
| `AGENTOME_RUN_ORPHAN_MINUTES`        | Minutes without a heartbeat after which a running run is closed as failed (`orphaned`); also how long a run may go on past a stop request or its time limit                                                                                    | `3`                                                                         |
| `AGENTOME_KNOWLEDGE_SYNC_MINUTES`    | Minutes between two syncs of a project's knowledge source with its repository; Sync now on the project page does not wait                                                                                                                      | `60`                                                                        |
| `AGENTOME_JIRA_POLL_MINUTES`         | Minutes between two polls of a Jira connection for changed issues; Sync issues now on Connections does not wait                                                                                                                                | `5`                                                                         |
| `AGENTOME_LOG_RETENTION_DAYS`        | Days the log lines in Admin → Logs are kept; older ones are deleted each hour                                                                                                                                                                  | `30`                                                                        |
| `AGENTOME_SETUP_ADMIN_EMAIL`         | Email of the administrator that the first start creates instead of `/setup`; set it with a password                                                                                                                                            | None                                                                        |
| `AGENTOME_SETUP_ADMIN_PASSWORD`      | That administrator's password, at least 12 characters                                                                                                                                                                                          | None                                                                        |
| `AGENTOME_SETUP_ADMIN_PASSWORD_FILE` | File that holds that password, for Docker secrets; a trailing newline is ignored                                                                                                                                                               | None                                                                        |
| `AGENTOME_SETUP_ORG_NAME`            | Company name for the setup that the first start completes                                                                                                                                                                                      | `Agentome`                                                                  |
| `AGENTOME_TRUST_PROXY`               | `true` behind one reverse proxy such as Caddy: the client's address is the one that proxy put last in `X-Forwarded-For`; a number trusts that many proxies in a row; see [Sign-in](#sign-in)                                                   | `false`; compose.yaml sets `true` with the proxy profile's domain           |
| `AGENTOME_KEYCLOAK_ISSUER`           | Address of the company's Keycloak realm, such as `https://sso.acme.com/realms/acme`; with the next two, the sign-in page offers Sign in with Keycloak; see [Keycloak](#keycloak)                                                               | None: no Keycloak                                                           |
| `AGENTOME_KEYCLOAK_CLIENT_ID`        | Client ID of Agentome's client in that realm                                                                                                                                                                                                   | None                                                                        |
| `AGENTOME_KEYCLOAK_CLIENT_SECRET`    | That client's secret                                                                                                                                                                                                                           | None                                                                        |
| `AGENTOME_UPDATE_CHECK`              | `false` stops Admin from asking GitHub for the latest release; see [Version](#version)                                                                                                                                                         | `true`                                                                      |
| `AGENTOME_PLACE_LAUNCHER_URL`        | Address of the place launcher (`http://place-launcher:8080` with the `places` profile); unset, people have no place on the server                                                                                                              | unset                                                                       |
| `AGENTOME_PLACE_IMAGE`               | The place launcher's: the seat image a person's place on the server runs; see OPERATIONS, Places on the server                                                                                                                                 | `agentome/agentome-seat` of this release                                    |

The server stops at the start when its environment holds `AGENTOME_PORT`, the old name of
`AGENTOME_LISTEN`, or `AGENTOME_HTTP_PORT`, the host port that compose.yaml publishes: either
is a setting that would otherwise be lost. A value of the form `tcp://ip:port` passes, since
Kubernetes sets `<SERVICE>_PORT` that way in the pods next to a Service of that name.

`AGENTOME_RUN_MAX_TOKENS` is checked while a run goes, against the tokens of its turns. Claude
Code reports an answer's output tokens only at the end of the run, in its result, so during a run
the count holds the output of each answer at one or two tokens: a run stops later than the limit
says by about what its answers wrote. The cost of a run is priced from the result.

## Version

Admin → Installation shows the version the server runs and its build, such as "Agentome 0.2.0,
build 572776f". The release build sets them in the image (`AGENTOME_BUILD_VERSION`,
`AGENTOME_BUILD_COMMIT`); an image built without them, from a checkout, is a development build.

When a newer release is out, Admin says so, with a link to what is new and to
[Updating](OPERATIONS.md#updating). The admin's browser asks GitHub for the latest release at
most once a day; the server itself asks nobody. With `AGENTOME_UPDATE_CHECK=false` the browser
does not ask either, for an installation whose people must not reach outside.

## Secret key

The server takes the first of:

1. `AGENTOME_SECRET_KEY`;
2. the contents of the file named by `AGENTOME_SECRET_KEY_FILE`;
3. `<AGENTOME_DATA_DIR>/secrets/secret.key`, which the first start creates with 32 random
   bytes (hex-encoded), readable only by the server's user (mode `0600`).

Keep the key stable: sessions are signed with it, and features that encrypt data with it
cannot read that data under a different key. The setup stores a fingerprint of the key, so a
server started with another key refuses to start:

```text
The secret key changed; restore AGENTOME_SECRET_KEY or the secrets volume
```

`agentome backup` saves the data directory, so a backup holds the key only in the third case;
a key from the environment or from a file elsewhere is yours to keep.

## Setup

A new installation has no accounts. Until the setup is complete, the API answers
`409 setup_required` and the web app opens `/setup`, where the first person names the company
and becomes its administrator; everyone else joins by invitation. `/setup` asks for the setup
code, so whoever reaches the server first cannot take it: the installer prints the code, and so
do `docker compose exec app agentome setup-code` and the server's log until the setup is done.
The code comes from the secret key and changes with it.

For an automated install, set `AGENTOME_SETUP_ADMIN_EMAIL` and `AGENTOME_SETUP_ADMIN_PASSWORD`
(or `_PASSWORD_FILE`): the first start completes the setup with an administrator named
"Administrator" and the company `AGENTOME_SETUP_ORG_NAME`. Once the setup is complete, these
variables are ignored.

## Sign-in

`AGENTOME_PUBLIC_URL` must be the address people type in the browser:

- sign-in and sign-out accept requests only from that origin;
- the session cookie is `Secure` when the address is `https://`, so an `https://` address
  served over plain HTTP cannot keep anyone signed in;
- invitation links point to it.

Agents reach the server at the same address, for the git proxy, from inside Claude Code's
sandbox. Give it a hostname, such as `agentome.corp.example`, not a private IP address: the
sandbox connects to `10.x`, `172.16.x` and `192.168.x` addresses directly, around its own proxy,
and then refuses the connection. `localhost` works for a stand on the computer that runs the
agents, and only for that.

Sign-in allows 3 attempts in 10 seconds from one address, counted by the server in memory.
Behind a reverse proxy, set `AGENTOME_TRUST_PROXY=true` (compose.yaml does with the proxy
profile): otherwise every request comes from the proxy's address, everyone shares one limit,
and sessions record the proxy. Leave it `false` when clients reach the server directly, or a
client could claim any address.

## Keycloak

People can sign in with the company's Keycloak beside their passwords. Keycloak
sign-in is part of Enterprise: it works while a license key holds and in its 14 days of
grace; without one the server logs a warning at start and people sign in with their passwords.
In the realm, create an OpenID Connect client for Agentome:

- client authentication on (a confidential client), standard flow only;
- valid redirect URI `<AGENTOME_PUBLIC_URL>/api/auth/callback/keycloak`;
- the default scopes `openid`, `profile` and `email`.

Then set `AGENTOME_KEYCLOAK_ISSUER`, `AGENTOME_KEYCLOAK_CLIENT_ID` and
`AGENTOME_KEYCLOAK_CLIENT_SECRET`, all three or none, and restart. Anyone the realm lets in gets
an account on the first sign-in, as a member; who may come in is the realm's to say, and admins
are made in Admin → People. A disabled person stays out. Sign-in with a password stays, so an
admin still gets in when Keycloak is down.

A Keycloak sign-in joins an account that has the same email only when both sides vouch for the
address: Keycloak marks it verified, and here it is the first admin's or one an invitation was
made out to. An account made from an open
invitation, or whose owner changed its email, keeps its password only, and its owner is told so.

## Database

The server takes `AGENTOME_DATABASE_URL` or the contents of the file named by
`AGENTOME_DATABASE_URL_FILE`, not both, and otherwise the default. Like libpq, it reads the
password from `PGPASSWORD` when the URL has none, which is how compose.yaml passes it. In a
URL, characters such as `/ # ? @ %` in the password must be percent-encoded (`%` as `%25`).
Errors about the URL never print it.

The server applies pending migrations on start, before it accepts requests; several instances
starting at once apply them only once. The role must own a database of its own: the
migrations keep their history in the schema `drizzle`, the job queue (pg-boss) keeps its
tables in `pgboss`, and `agentome restore` replaces every schema of the database.

## Web app

With `AGENTOME_WEB_DIR` set, the server answers a `GET` that no route of its own takes with
the file of that name. When the last segment of the path has no extension and the request
accepts `text/html`, as a browser's does, the answer is `index.html`, so that the app's own
pages (`/setup`, `/agents/…`) load. Anything else gets the JSON `404`, and so does every path
below `/api`, `/health`, `/ready`, `/openapi.json`, `/webhooks`, `/git`, `/mcp` and `/connect`.
Files under `assets/` carry a hash of their contents in their names and are cached for a year;
everything else, `index.html` first of all, is revalidated on every load. The server does not
start if the directory has no `index.html`.

## Run limits

Every run takes a time, turn and token limit to the computer that runs it, and the computer
stops the run when it reaches one. The `AGENTOME_RUN_MAX_*` settings are the defaults; an
agent's budget may set `maxMinutes`, `maxTurns` and `maxTokens` of its own. A running run that
sends no heartbeat for `AGENTOME_RUN_ORPHAN_MINUTES` is closed as failed with the code
`orphaned`; the server checks once a minute.

A project's knowledge (markdown of a connected repository, read through the code host's API)
is synced again once `AGENTOME_KNOWLEDGE_SYNC_MINUTES` have passed since its last sync; the
server looks once a minute, and an administrator can sync a source at once from the project
page.

## Compose and installer variables

These are read by [`compose.yaml`](../compose.yaml) and the scripts, from the shell or from a
`.env` next to compose.yaml ([`.env.example`](../.env.example) lists them); the server does
not read them.

| Variable                     | Purpose                                                                                                                                                      | Default                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `AGENTOME_VERSION`           | Tag of `docker.io/agentome/agentome` to run; an update or a rollback changes it                                                                              | The release this compose.yaml comes with  |
| `AGENTOME_HTTP_PORT`         | Port of the host that the app is published on; the server listens on 3000 in the container                                                                   | `3000`                                    |
| `AGENTOME_PUBLIC_URL`        | Passed to the server                                                                                                                                         | `http://localhost:<AGENTOME_HTTP_PORT>`   |
| `AGENTOME_POSTGRES_PASSWORD` | Password of the `agentome` database role, applied when the database volume is created; the install script puts a random one in `.env` for a new installation | `agentome`                                |
| `AGENTOME_PROXY_HOST`        | The domain, without `https://`, that the `proxy` profile serves and gets a certificate for                                                                   | None; the proxy does not start without it |
| `AGENTOME_LOG_LEVEL`         | Passed to the server                                                                                                                                         | `info`                                    |
| `AGENTOME_OAUTH_RETURN_URL`  | Passed to the server                                                                                                                                         | `AGENTOME_PUBLIC_URL`                     |
| `AGENTOME_INSTALL_BASE`      | Where `deploy/install.sh` downloads its files from                                                                                                           | `https://agentome.ai`                     |
| `COMPOSE_PROFILES`           | Compose's own: `proxy` adds Caddy with HTTPS to every command                                                                                                | None                                      |
| `COMPOSE_FILE`               | Compose's own: `compose.yaml:compose.local.yaml` adds a file of your own changes                                                                             | None                                      |
| `NODE_EXTRA_CA_CERTS`        | Node's own, set on the app in `compose.local.yaml`: a PEM file of the company's certificate authority (OPERATIONS.md)                                        | None                                      |

compose.yaml sets `AGENTOME_DATABASE_URL` to its own `postgres` service, without the password,
and `PGPASSWORD` to `AGENTOME_POSTGRES_PASSWORD`. With `AGENTOME_PROXY_HOST` set it also tells
the server to trust the proxy's `X-Forwarded-For` (`AGENTOME_TRUST_PROXY`). The image sets
`AGENTOME_LISTEN`, `AGENTOME_DATA_DIR` and `AGENTOME_WEB_DIR`.

Your own changes go into `.env` or into a `compose.local.yaml` (`COMPOSE_FILE` above), not
into compose.yaml or compose.override.yaml: both belong to the repository, and the second one
is what builds `agentome:local` in a checkout. `deploy/smoke.sh` publishes the app on
`AGENTOME_HTTP_PORT` and ignores `.env`.

## Invalid settings

If a value is invalid, the server prints the problems it found and exits with code 1:

```text
Invalid configuration:
  AGENTOME_LISTEN: Expected host:port, such as 0.0.0.0:3000
```

## Worker

The worker on an employee's computer (`apps/worker`) reads three settings of its own from its
environment. `install-service` copies the ones that are set into the service, so run it again
after changing one. An invalid value stops the command with a message that names the setting.

| Variable                          | Purpose                                                                                                                                                                         | Default       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `AGENTOME_WORKER_HOME`            | Folder of the connection (`config.json`, with the seat token), the state, the log and the runs                                                                                  | `~/.agentome` |
| `AGENTOME_WORKER_IDLE_MINUTES`    | Minutes without keyboard or mouse after which the computer takes no runs; a whole number ≥ 1                                                                                    | `15`          |
| `AGENTOME_WORKER_KEEP_WORKSPACES` | `1` keeps the folders of finished runs, to look into one; otherwise each is removed at finish                                                                                   | Unset         |
| `AGENTOME_WORKER_SERVER`          | `1` makes the worker a server seat: it pairs as one, takes runs with nobody at a keyboard, uses only the model connection's key and exits after each run. Set by the seat image | Unset         |
