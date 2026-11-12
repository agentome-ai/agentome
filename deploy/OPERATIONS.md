# Operations

Agentome runs from one file, [`compose.yaml`](../compose.yaml): the `app` container (the
server, the web app and the `agentome` command) and `postgres` (PostgreSQL 16), plus Caddy
for HTTPS when you turn on the `proxy` profile. Every command below runs in the directory
that holds `compose.yaml`. The settings are listed in [CONFIG.md](CONFIG.md). For a
Kubernetes cluster, see [Kubernetes](#kubernetes).

## Installing

You need a machine with Docker Engine 25 or newer and the Docker Compose plugin
(`docker compose version` answers). Nothing else is installed on the host.

### With the install script

```sh
curl -fsSL https://raw.githubusercontent.com/agentome-ai/agentome/main/deploy/install.sh | sh
```

The script creates `./agentome` and downloads `compose.yaml` and `.env.example` into it, and
`deploy/Caddyfile` if it is not there yet, from the repository's `main` branch. Then it pulls
the release, starts it, waits until it is healthy and prints the address of the first-run setup
and its setup code. Running it again updates `compose.yaml` and the images; your `.env` and the
Caddyfile stay as they are. To download from somewhere else, such as a mirror, set
`AGENTOME_INSTALL_BASE` to the address of the files.

### From the repository

```sh
git clone https://github.com/agentome-ai/agentome.git
cd agentome
docker compose up -d --build
```

Then open `http://localhost:3000/setup` with the setup code from
`docker compose exec app agentome setup-code`. In a checkout Compose also reads
[`compose.override.yaml`](../compose.override.yaml), which builds the image from the source
as `agentome:local`, so this works without access to the registry and never takes the name of
a release.

### Where the images come from

The releases are on Docker Hub: `docker.io/agentome/agentome` and, for agents on the server,
`docker.io/agentome/agentome-seat`, for amd64 and arm64. A machine without access to Docker Hub
pulls them through the company's registry mirror, or installs from the repository.

### What the first start creates

- The containers `agentome-app-1` and `agentome-postgres-1`. Only the app publishes a port:
  `3000`, or `AGENTOME_HTTP_PORT`. PostgreSQL is reachable from the app alone.
- The volume `agentome_agentome-postgres` with the database, and `agentome_agentome-data`,
  mounted at `/data`, with the secret key that the first start generates in
  `/data/secrets/secret.key`.
- The schema: the server applies the migrations before it reports healthy.

Open `/setup` to create the administrator. It asks for the setup code: the installer prints it,
and so do `docker compose exec app agentome setup-code` and the server's log until the setup is
done. If people reach the server by any other name than
`http://localhost:3000`, set `AGENTOME_PUBLIC_URL` in `.env` first.

## Configuring

Copy `.env.example` to `.env` and fill in what you need; an empty value keeps the default.
For anything `.env` cannot say, such as a Docker secret or another port mapping, write a
`compose.local.yaml` next to compose.yaml and add it with a line in `.env`:

```text
COMPOSE_FILE=compose.yaml:compose.local.yaml
```

Do not edit compose.yaml or compose.override.yaml: updates replace them. After a change,
`docker compose up -d` recreates what the change affects.

## License

Without a license key Agentome is Free, with no end: up to five active agents and one
team, agents on people's computers, no monthly budgets. A key, signed for a company and a term, usually a
year, makes it Enterprise. Admin → License shows Free or whom the key is for and until when,
the agents, and the installation ID; an admin pastes a key there, and it works at once, without
a restart. A key can be made out to one installation: send its installation ID with the request.

After the key's last day Agentome works 14 more days with a banner. Then an installation within
Free goes on as Free; one over Free (more agents or teams, agents on the server, monthly budgets)
turns read-only: everyone can still sign in and look at everything, but nothing runs or changes
until a key is in or an admin cuts it back to Free by archiving agents, removing teams, moving
agents to people's computers or taking monthly budgets off. Runs already going finish. The agent limit in
the key is counted, never enforced.

## Updating

Admin → Installation → Version says which version runs, and when a newer one is out
([CONFIG.md](CONFIG.md#version)).

1. Take a backup (see below).
2. Choose the version: set `AGENTOME_VERSION=X.Y.Z` in `.env`, or run the install script
   again, which downloads the newer `compose.yaml`.
3. Pull and restart:

   ```sh
   docker compose pull && docker compose up -d
   ```

In a checkout, `git pull && docker compose up -d --build` does the same from the source. The
new server applies its migrations on start, forward only, before it reports healthy;
`docker compose logs -f app` shows the progress. Your data stays in the volumes.

### The workers on people's computers

A connected computer keeps the worker it downloaded on the day it was connected. After an
update of the server, Admin → Computers says "Worker out of date" on every computer whose
worker is another build than the server now hands out. The row's menu has the command, which
the person runs in a terminal on that computer:

```sh
curl -fsSL https://agentome.example.com/connect | sh -s -- update
```

It downloads the worker, checks it against its checksum, replaces the file and starts the
background service again. The computer stays connected under its name and with its settings,
and the page stops saying so after the worker's next claim. The command refuses while a run is
in progress; a worker that runs in a terminal is stopped and started again by hand.

An old worker keeps taking runs. Update it soon all the same: the worker carries the sandbox
the agent's commands run in.

The server never sends a worker to a computer by itself: a server that was broken into would
then run its code on every connected computer. A new worker gets there only when a person runs
the command, as on the day the computer was connected.

The server seat's worker comes in its image; `docker compose --profile server-seat up -d`
starts the seat again from the server's version.

## Rolling back

Set `AGENTOME_VERSION` back to the previous version and run
`docker compose pull && docker compose up -d`.

Migrations only go forward, so an older version does not know the tables that a newer one
added. If the update you are undoing changed the schema (its changelog says so), restore
the backup you took before the update instead, with the older version running. Until the
first release, `v0.1.0`, the migrations are squashed into one, and pre-release builds do
not roll back.

## Backing up and restoring

A backup is one `.tar.gz` with the database (`db.dump`, made by `pg_dump`) and the data
directory (`data/`, which holds the generated secret key). Keep it as carefully as the
server itself: it contains the key and everything in the database.

```sh
(umask 077; docker compose exec -T app agentome backup > agentome-$(date +%F).tar.gz)
```

`-T` matters: without it Docker attaches a terminal and the archive is mangled. The shell on
this machine writes the file, so `umask 077` makes it readable by you alone; without it other
users of the machine could read the key. The command can run while the server is up, on a
schedule as well. In a crontab, `%` has to be escaped:

```text
0 3 * * * umask 077 && cd /srv/agentome && docker compose exec -T app agentome backup > backups/agentome-$(date +\%F).tar.gz
```

A restore replaces the database and the data directory with those of the archive. Stop the
server first, so that nothing writes in between:

```sh
docker compose stop app
docker compose run --rm -T app agentome restore < agentome-2026-10-21.tar.gz
docker compose up -d
```

The database is restored in one transaction: if anything fails, it stays as it was, and
the data directory is replaced only after the database. The restore reads only the database
settings and the data directory, so it works even when the key or another setting is broken.
Restore with the version that made the backup or a newer one, which migrates it forward on
start. To move an installation to another machine, install the same version there and run
the same three commands. `tar -tzf agentome-2026-10-21.tar.gz` lists what an archive holds.

## A forgotten password

Agentome sends no mail, so the sign-in page has no "forgot password" to click. Whoever runs the
server gets a link for the person and hands it over:

```sh
docker compose exec app agentome reset-password ann@example.com
```

The link opens a page that sets a new password. It works once, for an hour, and asking for
another makes the earlier one useless. The new password signs the person out everywhere and
revokes their personal API tokens; their computers stay connected, and one that is not theirs
is revoked in Admin → Computers. This is also the way back for the only admin: it needs the
machine, not a sign-in.

The command says so when the account is disabled: a new password does not let a disabled person
in until an admin enables them. It refuses an account that signs in through Keycloak and has no
password here: who gets in there is the realm's to say.

The link is as good as the password until it is used or runs out, so pass it as you would a
password, and not through a channel others read. Its secret is the part after the `#`, which a
browser does not send: it is not in the server's log or a proxy's.

## The PostgreSQL password

The default password is `agentome`. The database is not published on any port, only the app
reaches it, so the password protects nothing that is exposed. To use another one, set it in
`.env` before the first start; any characters will do, `openssl rand -hex 24` makes one:

```text
AGENTOME_POSTGRES_PASSWORD=<the password>
```

PostgreSQL reads that variable only when it creates its volume. To change the password of a
running installation, change it in the database first, then in `.env`:

```sh
docker compose exec postgres psql -U agentome -d agentome -c '\password agentome'
# put the same password into .env as AGENTOME_POSTGRES_PASSWORD, then:
docker compose up -d
```

### The database URL from a Docker secret

To keep the connection string, of a database of your own say, in a secret instead, give the
app the file and turn off the URL and password that compose.yaml sets. An empty value counts
as unset:

```yaml
# compose.local.yaml
services:
  app:
    environment:
      AGENTOME_DATABASE_URL: ''
      PGPASSWORD: ''
      AGENTOME_DATABASE_URL_FILE: /run/secrets/database-url
    secrets: [database-url]
secrets:
  database-url:
    file: ./database-url.txt
```

`docker compose config` shows the result. With both the URL and the file set, the server
stops at the start and says so.

## HTTPS with the proxy profile

Connect computers only once the server has an HTTPS address. A computer connects by running the
script at `/connect`, which downloads the worker and its checksum from the same address: over
plain HTTP, anyone on the network path can hand the computer code of their own. The server warns
at start when its address is plain HTTP and not `localhost`.

The `proxy` profile adds Caddy, which answers on ports 80 and 443 and gets a certificate for
the domain in `AGENTOME_PROXY_HOST` from Let's Encrypt on its own, and renews it.

1. Point a DNS record for the domain, `agentome.example.com` say, at the machine, and open
   ports 80 and 443 to the internet: the certificate authority checks both.
2. In `.env`, set the domain and the address people open, which is the same one with
   `https://`, and turn the profile on for every command:

   ```text
   AGENTOME_PROXY_HOST=agentome.example.com
   AGENTOME_PUBLIC_URL=https://agentome.example.com
   COMPOSE_PROFILES=proxy
   ```

3. Behind the proxy the server trusts the client address in `X-Forwarded-For`, so the app's
   own port must not be reachable from outside, where anybody could send that header. Take
   it off the host in `compose.local.yaml` (see Configuring):

   ```yaml
   services:
     app:
       ports: !reset []
   ```

4. `docker compose up -d`, then open `https://agentome.example.com/setup` with the setup code
   from `docker compose exec app agentome setup-code`.

The certificates live in the volume `agentome_caddy-data`. Without `AGENTOME_PROXY_HOST` the
proxy does not start and says so. On a network without access to a public certificate
authority, change `deploy/Caddyfile` to use your own certificate or `tls internal` (see the
[Caddy documentation](https://caddyserver.com/docs/caddyfile/directives/tls)); the install
script never replaces the file once it is there.

Every answer carries the browser's rules for the page: a Content Security Policy that runs only
the server's own scripts (and index.html's one inline script, by its hash), loads images and fonts
only from the server, so a link or picture an agent wrote cannot call another site when shown, and
lets no other site frame Agentome; `nosniff`; and, at an HTTPS address, HSTS for half a year. With
the proxy profile, plain HTTP on port 3000 answers only this machine, so nobody can skip the proxy
and claim another client address. `/openapi.json` stays public: it describes the same API the
public source does.

## HTTPS on a local network

Phones and browsers deliver notifications only to an HTTPS address. Without a domain, the
`proxy` profile serves the machine's IP address with a certificate from Caddy's own
authority, which each phone trusts once.

1. Give the machine a fixed address on the router: the certificate is for that address.
2. In `.env`, set the address and turn the profile on, as above (step 3 of the section above
   applies here too):

   ```text
   AGENTOME_PROXY_HOST=192.168.1.20
   AGENTOME_PUBLIC_URL=https://192.168.1.20
   COMPOSE_PROFILES=proxy
   ```

3. `docker compose up -d`, then copy Caddy's root certificate out:

   ```sh
   docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt agentome-root.crt
   ```

4. Trust it on each phone and computer that opens Agentome:
   - iPhone and iPad: AirDrop or mail the file and open it, install the profile in Settings,
     then turn on full trust for "Caddy Local Authority" in Settings > General > About >
     Certificate Trust Settings.
   - Android: Settings > Security > Encryption & credentials > Install a certificate > CA
     certificate, and pick the file.
   - A Mac: open the file in Keychain Access and set it to Always Trust.

5. Open `https://192.168.1.20` on the phone. On an iPhone, tap Share, then Add to Home Screen,
   and open Agentome from there: Safari itself gets no notifications. Then, in the menu under
   your name, Notifications > Turn on notifications, and Send a test.

The pushes travel through the push service of the phone's maker (Apple, Google or Mozilla),
so the server needs to reach the internet on port 443, and the phone needs internet too. The
root certificate lasts ten years and lives in the volume `agentome_caddy-data`; a new volume
makes a new one, which every phone has to trust again. An installation whose Caddyfile is
older than this section lacks its `default_sni` line: copy it from the repository's
`deploy/Caddyfile`.

## A company certificate authority

On a company network, the servers the agents use, an MCP server behind the company's model
gateway or a self-hosted Jira or GitLab, often carry certificates that the company's own root
authority signs. The image does not know that authority, so the server refuses them with
`self-signed certificate in certificate chain`. Give it the root certificate:

1. Get the root certificate as a PEM file from IT, or take it from the chain a server sends
   (`openssl s_client -connect host:443 -showcerts`, the last certificate) and compare its
   fingerprint with the one IT or a company computer shows before you trust it.
2. Put it next to compose.yaml, as `company-root.pem` say, and add it in `compose.local.yaml`
   (see Configuring). `NODE_EXTRA_CA_CERTS` is Node's own: the server trusts the file's
   certificates on top of the ones it knows, for every outgoing connection.

   ```yaml
   services:
     app:
       environment:
         NODE_EXTRA_CA_CERTS: /etc/agentome/company-root.pem
       volumes:
         - ./company-root.pem:/etc/agentome/company-root.pem:ro
   ```

3. `docker compose up -d`. One file may hold several certificates, one after another.

## Places on the server

A person can have a place of their own on the server: a container that the platform makes for
them, in which they sign in to Claude Code or Codex with their own subscription once, and which
runs their agents while they work in Agentome. Nothing is installed on their computer. A place
takes runs only while its person is present: a tab of Agentome open and in use within their idle
time. A run that started goes on to its end.

1. Start the launcher and tell the app where it is: put `AGENTOME_PLACE_LAUNCHER_URL=http://place-launcher:8080`
   in `.env`, then `docker compose --profile places up -d`.
2. Each person makes their place in **Computers → Your place on the server**, wakes it, puts it to
   sleep and deletes it there.
3. Each person signs their place in from **Open terminal** there: a terminal in their place, in the
   browser, where they run `claude` and sign in with their Claude subscription, or
   `codex login --device-auth` (a link and a code: the browser cannot reach the place itself).
   Agentome keeps neither the sign-in nor what is typed; its log says only that a terminal opened
   and closed. A place does not sleep while its terminal is open.

The launcher is the only service with Docker's socket. It takes signed orders from the app and
makes a place only from the seat image of this release, without capabilities, with no way to gain
any, a read-only root, at most 8 GB of memory, 1024 processes and 2 CPUs, on the network
`agentome-places`, which reaches the app and nothing else of Agentome's. A place keeps two volumes,
`agentome-place-<id>-home` (the sign-in) and `agentome-place-<id>-seat` (its connection, the CLI
and the agents' working folders). Once a minute the app wakes a place whose person is present and
has a run queued, and puts to sleep one in which nothing has run for the person's idle time:
sleeping stops the container and keeps the volumes. Deleting a place deletes both volumes.

A project's work may need services next to it: a database, a queue, another service. A place
takes them from the devcontainer of the project's main repository: `.devcontainer/devcontainer.json`
(or `.devcontainer.json`) on its default branch and the compose files its `dockerComposeFile`
names. Agentome reads them when the main repository changes and when someone asks
(`POST /api/projects/:id/environment`, or `read_project_environment` from Claude Code). Every
service but the devcontainer's own `service`, or those in `runServices`, comes through with its
`image`, `environment` (defaults of `${VAR:-default}` only, nothing of the server's), `command`
and named volumes; a service that is built, privileged, asks for capabilities, devices or the
host's network, or mounts a folder of the host is left out, and the project says why. The
images are whatever the repository names, run on the company's server, so a list runs only once
an admin has approved it (`POST /api/projects/:id/environment/approve` with the list's hash, or
`approve_project_environment`); a changed list needs approval again.

When a run of such a project is the next for a person's place, the place gets ready first, and
the claim waits meanwhile (`x-agentome-waiting: services`; pulling images may take minutes). With
Docker, the services run as containers of their own on an internal network of the project's,
`agentome-place-<id>-<project>`, which the place joins and where they answer to their compose
names; another project's services are stopped and the place leaves their network, so two projects
may both have a `db`. On Kubernetes, the place's pod is made again with the services as containers
of its own, their names pointing to the pod itself, their volumes on the place's seat claim. A
service keeps its image's user and capabilities, gains no privilege, has 1 CPU and 2 GB of memory,
and reaches nothing outside the place. The agent's CLAUDE.md names the services, and calls to
them bypass the egress proxy. Sleep stops the services; deleting the place removes them with
their volumes. When they do not start, the app's log says why, and the place's runs go without
them for 15 minutes before it tries again. Images from a registry that needs signing in are not
supported yet.

A place, like the server seat, runs the seat image, which has the common toolchains, so that an
agent builds most projects without installing anything: Python 3.11 with pip and venv, Java 21
(Temurin) with Maven, Go 1.27, .NET 8 SDK, gcc and make, and Node 22. A Gradle project brings its
own wrapper. The image is about 3.6 GB.

A place has no way out of its own: `agentome-places` is an internal network, and every call a
place makes past the app goes through the egress proxy, `place-egress` in the same profile. The
proxy asks the app which hosts the call's token opens and connects to those only; it never reads
what passes through. A run's token opens Agentome's address, the model vendors' hosts
(`anthropic.com`, `claude.ai`, `claude.com`, `openai.com`, `chatgpt.com` and their subdomains) and the hosts its
task's project allows; the place's own token, which its worker and terminal use, opens Agentome,
the vendors and `registry.npmjs.org`, from which the place installs its CLI at its first start.
An admin lists a project's hosts in `allowedHosts` (`PATCH /api/projects/:id`, or `update_project`
from Claude Code): a host name, `*.example.com` for every name under it, or an IPv4 address, such
as the company's GitLab, Jira and package mirror. Node's own `fetch` uses the proxy too
(`NODE_USE_ENV_PROXY=1` in a place).

Every place event is in **Admin → Logs**, under the place's seat and, for a run, the run: made,
woken, put to sleep and why, deleted, an agent's folders emptied, a terminal opened and closed
(never what went through it), its services started or not. The egress proxy tells the app each
host it refused (`a place was refused …`, a warning) and, once a minute a token, each host it let
out (`a place reached …`, with how many connections), by the token each call came with, so a line
names the run or place it was for and never the token; `docker compose logs place-egress` has the
refusals too.

In a place, an agent keeps one working folder per repository between runs, under `/seat/folders`:
what git ignores (dependencies, builds) stays, and at the start of each run the worker writes the
folder's git configuration anew, empties its hooks, saves what the last run left uncommitted to a
branch `agent/leftover-<run>` and pushes it, and sets the tracked files to the default branch. A
folder unused for 30 days goes; **Working folders → Start fresh** in the person's place empties an
agent's at once.

## Agents on the server

Most people's agents run on their own computers under their subscription. An agent set to work on
the server (Engine & model → Where it works) runs on the server seat instead, on a model
connection from Admin → Models. The connection's key never leaves the server: the seat calls the
model through the server's relay at `/model`, with the run's own token, and the server puts the key
on each call and passes it on. The token stops working when the run ends. The seat is off until you
start it:

1. In Admin → Models, add a connection: Anthropic or OpenAI with an API key, or a gateway such as
   LiteLLM or OpenRouter. Give it a key made for agents, with a spending limit at the provider.
2. In Admin → Computers, Connect a computer makes a code; as an admin you see the server seat's
   command with it. On the machine that runs Agentome:

   ```sh
   docker compose run --rm seat connect <code> --server http://app:3000
   docker compose --profile server-seat up -d
   ```

3. Set an agent to the server, with the connection and a model from it: a Claude model for
   Claude Code, another for Codex.

Codex on a computer: install it (`npm install -g @openai/codex`, 0.163.0 or later) and sign in
with `codex login`, under the person's ChatGPT subscription; the worker finds `codex` on its
`PATH` when it starts, so start the worker again after installing Codex; it then takes the
owner's Codex agents. The Codex inside the ChatGPT app is not on the `PATH` and is not found.
The agent's commands run in Codex's own sandbox: they read the system and the tools' folders, not the person's home; they write the run's clone; they
reach the server and nothing else. Before each run the worker checks that this sandbox holds on
the computer and fails the run (`sandbox_unavailable`) when it does not, or when Codex is too
old. One limit: Codex's proxy refuses a server whose name resolves to a private address, so with
a server inside the company network a Codex agent on a computer cannot `git push` through the git
proxy; its tools work. An agent on Claude Code has no such limit.

The seat's image holds Codex but not Claude Code, whose license does not let us hand it out.
It holds the list of what to install: the pinned version and the checksum of each package. At
each start the seat installs Claude Code from that list into memory and keeps npm's cache in its
volume, so the first start needs a way to the npm registry and takes about half a minute, and later
starts take two seconds and need no registry. Claude Code takes about 220 MB of the seat's memory. A network without one gives the seat a mirror in npm's own
`NPM_CONFIG_REGISTRY` (`environment:` of the `seat` service in your `compose.local.yaml`).
Without either the seat does not start and its log says so.

The seat takes one run and exits, and compose starts it again clean: its file system is
read-only but for its connection and npm's cache (`agentome-seat`), and the run and Claude Code,
which live in memory. Every start checks the cache against the image's checksums, so a run
cannot leave a changed CLI for the next one. It has no Linux capabilities and cannot gain any, and
at most 8 GB of memory (its in-memory folders count), 1024 processes and 2 CPUs. It is on
a network of its own that reaches the app and the internet, not the database. Its agents have no
shell unless an admin allowed one: with a shell an agent could read the seat's own token and the
run's, which reach the model and the agent's tools until the run ends, never the connection's key. In production, run the seat on a machine of its own, pointed at your
Agentome's address instead of `http://app:3000`. For more seats at once, start more:
`docker compose --profile server-seat up -d --scale seat=3`, each connected with a code.

## MCP servers that sign in with OAuth

A library MCP server can sign each person in with OAuth: Sign in in the library
opens the server's sign-in in the browser, and the browser comes back to Agentome at
`/api/library/mcp/oauth/callback`. The server's authorization server must accept that return
address, or the sign-in stops at once with `invalid_request`.

- **On a company network** ask the administrators of the authorization server (for an MCP
  server behind a model gateway such as LiteLLM, its administrators) to allow
  `https://<your Agentome address>/api/library/mcp/oauth/callback`, and leave
  `AGENTOME_OAUTH_RETURN_URL` unset: the return address is then `AGENTOME_PUBLIC_URL`, and
  coming back needs the person's session, as signing in to Agentome does.
- **On one computer**, when the authorization server takes only `localhost` and Agentome runs
  on the computer the person signs in from, set `AGENTOME_OAUTH_RETURN_URL` to Agentome's
  address there, such as `http://localhost:3100`. There the sign-in's one-time state names the
  person instead of the session, which belongs to the public address. People on other
  computers cannot sign in this way: their browser cannot reach that `localhost`.

When the return address changes, Agentome registers itself with the authorization server again
at the next sign-in, and each person signs in once more.

## Kubernetes

[`deploy/kubernetes/`](kubernetes/) holds plain manifests for kustomize, which `kubectl`
has built in; no Helm chart and no operator:

- `kustomization.yaml`, the file you edit: the namespace, the address, the release and the
  server's settings.
- `agentome.yaml`: the server as a Deployment with one replica, its Service and a volume for
  the data directory.
- `ingress.yaml`: HTTPS at the address people open, with the certificate from a TLS secret.
- `postgres/`: PostgreSQL 16 as a StatefulSet with a volume of its own, a component that
  `kustomization.yaml` lists. With a database of the company's own, remove it from there.
- `secret.example.yaml`: the shape of the Secret `agentome`, which holds the secret key and
  the database's address and password. The kustomization leaves it out, so that no password
  ends up in a repository next to the manifests.
- `places/`: people's places on the server, a component that `kustomization.yaml` lists once
  you take the `#` off its line (see [Places on Kubernetes](#places-on-kubernetes)).

The server seat, for agents on the server, is not covered yet: agents run on people's
computers, or on a seat started with compose on a machine of its own (see
[Agents on the server](#agents-on-the-server)), pointed at the Ingress address.

### Installing on Kubernetes

1. Take `deploy/kubernetes/` of the release you install. In `kustomization.yaml`, set the
   namespace, `AGENTOME_PUBLIC_URL` (the Ingress takes its host from it, so the two always
   match) and `newTag`. Without PostgreSQL in the cluster, remove the `components` lines.
2. In `ingress.yaml`, set `ingressClassName` if the cluster has no default class, and give
   the certificate: a `kubernetes.io/tls` Secret named `agentome-tls`, or cert-manager's
   annotation, which makes one.
3. Create the namespace and the Secret. The secret key is yours to keep (see below); the
   address is the one for PostgreSQL in the cluster:

   ```sh
   kubectl create namespace agentome
   kubectl -n agentome create secret generic agentome \
     --from-literal=AGENTOME_SECRET_KEY="$(openssl rand -hex 32)" \
     --from-literal=AGENTOME_DATABASE_URL=postgres://agentome@postgres:5432/agentome \
     --from-literal=PGPASSWORD="$(openssl rand -hex 24)"
   ```

   Or fill in a copy of `secret.example.yaml` and `kubectl apply -f` it. For the company's
   database, give its address instead, with a role that owns a database of its own
   ([CONFIG.md](CONFIG.md#database)), and its password in `PGPASSWORD`.

4. Apply and wait until the server is ready; the first start applies the migrations:

   ```sh
   kubectl apply -k deploy/kubernetes
   kubectl -n agentome rollout status deploy/agentome
   ```

5. Open `https://<your host>/setup` with the setup code from
   `kubectl -n agentome exec deploy/agentome -- agentome setup-code`.

Computers connect to the Ingress address, `AGENTOME_PUBLIC_URL`: the commands in Admin →
Computers carry it. Give it a hostname, not an IP address ([CONFIG.md](CONFIG.md#sign-in)).

The server trusts `X-Forwarded-For` (`AGENTOME_TRUST_PROXY=true`), as it must behind the
Ingress. Its Service has no address outside the cluster, so only the Ingress controller and
other pods reach it directly; a NetworkPolicy that admits the controller alone closes the
rest. A company certificate authority goes in as with compose: `NODE_EXTRA_CA_CERTS` among the
settings in `kustomization.yaml`, and the PEM file mounted from a ConfigMap with a patch.

### Places on Kubernetes

With the `places` component, a person's place is a pod of theirs in the namespace, with two
volume claims: `agentome-place-<id>-home` (1 GiB, the sign-in) and `agentome-place-<id>-seat`
(20 GiB, the connection, the CLI and the agents' working folders), of the cluster's default
storage class. Sleeping deletes the pod and keeps the claims; waking makes the pod again on the
same claims. Everything else is as in [Places on the server](#places-on-the-server).

- `place-launcher` makes the pods. Its service account may get, create and delete pods and
  volume claims in the namespace, and open a command in a pod (the terminal, and emptying an
  agent's folders), and nothing in the cluster. It checks the server's orders with a key from
  the Secret's `AGENTOME_SECRET_KEY`.
- `place-egress` is the places' only way out, as with compose.
- NetworkPolicies let a place reach the server, the egress proxy and the cluster's DNS, and
  take no connection; only the server reaches the launcher, and only places the proxy. They
  need a network plugin that enforces NetworkPolicies (Calico, Cilium, and kind's own do).
- A place's pod runs as uid 1000, without capabilities or a token of the cluster, with a
  read-only root and at most 2 CPUs and 8 GiB of memory.

### The secret key on Kubernetes

Here the key comes from the Secret, not from the data volume as with compose. It has to stay
with the database, which may be the company's own and outlive the cluster, while a volume goes
with its namespace. So `agentome backup` does not hold it: keep a copy with your backups,

```sh
kubectl -n agentome get secret agentome -o jsonpath='{.data.AGENTOME_SECRET_KEY}' | base64 -d
```

and do not change it later, or the server refuses to start. Moving from compose, put the old
installation's key into the Secret: a backup made there holds it,
`tar -xzOf agentome-2026-10-21.tar.gz data/secrets/secret.key`.

### Updating on Kubernetes

Take a backup, set `newTag` in `kustomization.yaml` and `kubectl apply -k deploy/kubernetes`.
The old pod stops before the new one starts, and the new one applies its migrations before it
reports ready; `kubectl -n agentome logs -f deploy/agentome` shows the progress. Rolling back
is the same with the earlier tag, under the conditions of [Rolling back](#rolling-back). A
change to the Secret reaches the server only when it starts again:
`kubectl -n agentome rollout restart deploy/agentome`.

### Backing up and restoring on Kubernetes

The same archive as with compose, through `kubectl exec`; no `-t`, which would mangle it:

```sh
(umask 077; kubectl -n agentome exec deploy/agentome -- agentome backup > agentome-$(date +%F).tar.gz)
```

A restore needs the server stopped, so it runs in a pod of its own with the same Secret and
volume, then the server starts again:

```sh
kubectl -n agentome scale deploy/agentome --replicas=0
kubectl -n agentome run agentome-restore --rm -i --restart=Never \
  --image=docker.io/agentome/agentome:0.2.0 --override-type=strategic --overrides='
{"spec": {"securityContext": {"runAsNonRoot": true, "runAsUser": 1000, "runAsGroup": 1000,
    "fsGroup": 1000, "seccompProfile": {"type": "RuntimeDefault"}},
  "containers": [{"name": "agentome-restore", "envFrom": [{"secretRef": {"name": "agentome"}}],
    "securityContext": {"allowPrivilegeEscalation": false, "capabilities": {"drop": ["ALL"]}},
    "volumeMounts": [{"name": "data", "mountPath": "/data"}]}],
  "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "agentome-data"}}]}}' \
  -- agentome restore < agentome-2026-10-21.tar.gz
kubectl -n agentome scale deploy/agentome --replicas=1
```

Use the image of the release that runs. A database of the company's own may be backed up by
its own means instead; the secret key is what the server adds to it.

## Troubleshooting

- `docker compose ps` shows whether the containers are up and healthy.
- `docker compose logs -f app` follows the server's log, one JSON object per line. For more
  detail, set `AGENTOME_LOG_LEVEL=debug` in `.env` and run `docker compose up -d`.
- `/health` answers while the server process lives, `/ready` once the database answers
  too: `curl http://localhost:3000/ready`. A `503` with `not_ready` means that the server
  cannot reach PostgreSQL.

| What you see                                                                      | What it means and what to do                                                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Bind for 0.0.0.0:3000 failed: port is already allocated`                         | Something else uses port 3000. Set `AGENTOME_HTTP_PORT=3100` in `.env`.                                                  |
| The app restarts, and its log starts with `Invalid configuration:`                | A setting is wrong; the message names it. [CONFIG.md](CONFIG.md) lists the valid values.                                 |
| `AGENTOME_HTTP_PORT: this is the host port that compose.yaml publishes`           | `.env` was handed to the app itself, with `env_file` say. Only compose.yaml reads that variable; remove it from the app. |
| `password authentication failed for user "agentome"` in the log of the app        | `AGENTOME_POSTGRES_PASSWORD` changed after the database was created. Change it in the database too (see above).          |
| `docker compose pull` answers `denied` or `not found`                             | That version does not exist on Docker Hub: check `AGENTOME_VERSION` against the releases.                                |
| `AGENTOME_PROXY_HOST, the domain, is required for the proxy profile`              | The proxy profile is on without a domain: set `AGENTOME_PROXY_HOST` in `.env`.                                           |
| Caddy logs `obtaining certificate` errors                                         | The DNS record does not point at this machine yet, or ports 80 and 443 are closed.                                       |
| The phone says the connection is not private                                      | Its trust in Caddy's root certificate is missing or off; see "HTTPS on a local network".                                 |
| `agentome backup: the archive goes to stdout`                                     | The command needs `-T` and a redirect: `docker compose exec -T app agentome backup > file.tar.gz`.                       |
| `agentome restore: the archive has no db.dump and data/`                          | The file is not a backup made by `agentome backup`.                                                                      |
| `self-signed certificate in certificate chain` from an MCP server or a connection | The server does not know the company's certificate authority; see "A company certificate authority".                     |
| Computers says `Claude Code is not signed in`, and tasks stay queued              | Its runs wait. On that computer run `claude` (`codex login` for Codex) and sign in; the worker asks again in a minute.   |
| `{"detail":"invalid_request"}` when signing in to an MCP server                   | Its authorization server does not accept the return address; see "MCP servers that sign in with OAuth".                  |

## Removing an installation

`docker compose down` stops and removes the containers and keeps the volumes, so a later
`docker compose up -d` carries on where it stopped. `docker compose down -v` also deletes
the volumes: the database and the secret key are gone for good, so take a backup first.
