# Deploy on your server

This page is for the admin who puts Agentome on the company's own server, so that people's agents
run there and not on their computers. It covers what the server needs, a Docker Compose install
with places under gVisor, the same on Kubernetes, the network the agents get, and what to check
before a pilot. The details of each step are in [Operations](../../deploy/OPERATIONS.md); every
setting is in [Configuration](../../deploy/CONFIG.md).

## What the server needs

- **Linux** on x86-64 or arm64, inside the company's network, with **Docker Engine 26 or newer**
  and the Compose plugin, or a Kubernetes cluster.
- **gVisor** (`runsc`), so that every place and every run has a kernel of its own instead of the
  host's. Install it from [gvisor.dev](https://gvisor.dev/docs/user_guide/install/).
- **Room for places.** Each person who works with agents has a place, a container of their own,
  which takes at most 2 CPUs and 8 GB of memory while it is awake, and up to 20 GB of disk for its
  sign-in and working folders. A place sleeps when nothing has run for a while.
- **A name and HTTPS** for the server, such as `agentome.example.com`: people open it in the
  browser, and agents reach the server's gateway and git proxy by it.
- **Outbound HTTPS** from the server to the model vendors (`api.anthropic.com`,
  `platform.claude.com`, `claude.ai`, `api.openai.com`, `auth.openai.com`, `chatgpt.com`) and to
  `registry.npmjs.org`, from which a place installs the official Claude Code and Codex. Everything
  else the agents reach, your GitLab, Jira or package mirror, you open per project.

## Install with Docker Compose

Once gVisor is registered with Docker (step 2 below), one command does steps 1 and 3: it asks for
the domain and whether places run here, and turns gVisor on for them.

```sh
curl -fsSL https://agentome.ai/install.sh | sh -s -- --domain agentome.example.com --places
```

By hand, or to see what it does:

1. Install the server as in [Getting started](getting-started.md#1-install-the-server), and
   give it HTTPS: with a public name, the `proxy` profile gets a certificate from Let's Encrypt
   ([HTTPS with the proxy profile](../../deploy/OPERATIONS.md#https-with-the-proxy-profile));
   inside the company's network, use the company's certificate
   ([HTTPS on a local network](../../deploy/OPERATIONS.md#https-on-a-local-network),
   [A company certificate authority](../../deploy/OPERATIONS.md#a-company-certificate-authority)).
2. Register gVisor with Docker in `/etc/docker/daemon.json` and restart Docker. The second
   runtime is for a run's own Docker (step 4), and only for it:

   ```json
   {
     "runtimes": {
       "runsc": { "path": "/usr/local/bin/runsc" },
       "runsc-docker": {
         "path": "/usr/local/bin/runsc",
         "runtimeArgs": ["--net-raw", "--allow-packet-socket-write"]
       }
     }
   }
   ```

3. Turn places on in `.env`, beside the settings of step 1, and start them:

   ```text
   COMPOSE_PROFILES=proxy,places
   AGENTOME_PLACE_LAUNCHER_URL=http://place-launcher:8080
   AGENTOME_PLACE_RUNTIME=runsc
   ```

   ```sh
   docker compose up -d
   ```

4. If your projects' tests start containers (testcontainers, a compose stack), give each run a
   Docker of its own, which lives inside gVisor and goes with the run:

   ```text
   AGENTOME_PLACE_DOCKER_RUNTIME=runsc-docker
   ```

5. If you want agents only on the server, and no person's computer to connect, add
   `AGENTOME_COMPUTERS=false`.

With more than a dozen places, give Docker smaller address pools, which must not overlap the
company's networks: see [Places on the server](../../deploy/OPERATIONS.md#places-on-the-server).

## Install on Kubernetes

The manifests are in `deploy/kubernetes` of the release. Places, their launcher and their egress
proxy are in `places`, a namespace of their own, `agentome-places`, so the launcher never makes a
pod where the database and the app's secret are. In short:

1. Install gVisor on the nodes and create its RuntimeClass, `gvisor` say.
2. Set the namespace, `AGENTOME_PUBLIC_URL` and the image tag in `kustomization.yaml`, the
   certificate in `ingress.yaml`, and create the Secret with the secret key and the database's
   address. Apply `ingress-proxy.yaml` in the ingress controller's namespace, so that the server
   takes the client's address from the controller alone.
3. `kubectl apply -k deploy/kubernetes`, then open `/setup` with the setup code.
4. For places: set the image tag and `AGENTOME_PLACE_RUNTIME=gvisor` (the RuntimeClass's name) in
   `places/kustomization.yaml`, `kubectl apply -k deploy/kubernetes/places`, turn on
   `AGENTOME_PLACE_LAUNCHER_URL` in `kustomization.yaml`, and give the places their keys with
   `agentome places-key` and `agentome egress-key`. The cluster's network plugin must enforce
   NetworkPolicies: Calico and Cilium do.

Every step is in [Kubernetes](../../deploy/OPERATIONS.md#kubernetes). On Kubernetes a run has no
Docker of its own yet: a project's databases come from its devcontainer, as its services.

## The network agents get

A place and its runs have no way out but the egress proxy, which lets each through to what it
needs and nothing else:

| Who                                   | Reaches                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| The CLI, in a run's CLI container     | The model vendors and Agentome                            |
| Every command, in the run's sandbox   | Agentome and the hosts the task's project allows          |
| A run's own Docker                    | The hosts the project allows, for pulling images          |
| The place itself, between runs        | The model vendors and npm, to install and sign in the CLI |
| A project's services (a database say) | Nothing outside                                           |

An admin opens hosts per project in its **Network** section: the company's GitLab, Jira, a package
mirror. **Add public package registries** adds npm, PyPI, Maven, Go, NuGet and Docker Hub at once,
for a project without a mirror. A host a run was refused shows there for a week, with **Allow**
beside it; a host allowed that way reaches public addresses only, since a run chose its name. The
proxy lets a host through on port 443 unless the list names another, connects only to the address
it checked, and reaches the company's own networks only for a host an admin added by its full
name with **Add host**.

The proxy also connects to the server's own public name, for the CLI's gateway. Make sure the
name resolves to an address the server's containers reach: on a network whose router does not
loop a public address back inside, give the name an internal record, or an alias on the
`egress` network (see [Places on the server](../../deploy/OPERATIONS.md#places-on-the-server)).

## Keep it running

The install script's `agentome` command does these from any folder on the server:

- **Updates:** `agentome backup`, then `agentome update`; places are made anew from the new image
  when they next wake. See [Updating](../../deploy/OPERATIONS.md#updating).
- **Backups:** `agentome backup` writes the database; keep the secret key apart from it. See
  [Backing up and restoring](../../deploy/OPERATIONS.md#backing-up-and-restoring).
- **A key that may have leaked:** `agentome rotate-key` seals every secret under a new one. See
  [Rotating the secret key](../../deploy/OPERATIONS.md#rotating-the-secret-key).
- **Logs:** **Admin → Logs** shows what the server, the egress proxy and the runs did.

## Before a pilot

- [ ] The server answers on HTTPS by its name, and `/setup` is done.
- [ ] Admins sign in with a code from an authenticator app, which Agentome asks of every admin.
- [ ] `AGENTOME_PLACE_RUNTIME` is set, and `docker info` lists `runsc`.
- [ ] A person made their place, signed in with `claude` (or `codex login --device-auth`) in its
      terminal, and an agent finished a task in it.
- [ ] Each project lists only the hosts it needs, and its code host connection reaches only its
      repositories.
- [ ] CI secrets are out of an agent branch's reach: protected variables on GitLab, environments
      on GitHub (see [Integrations](integrations.md#what-ci-runs-for-an-agents-push)).
- [ ] Backups run on a schedule, and the secret key is kept apart from them.

How runs are kept apart from what they must not reach is on [Security](security.md).
