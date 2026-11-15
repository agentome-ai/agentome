# agentome

One program for [Agentome](https://agentome.ai), the self-hosted platform for AI employees:
install the server on a machine of yours, connect a computer to the one your company runs, or
manage it from an MCP client.

```sh
npm install -g agentome
```

Or without installing it, with `npx agentome …`. Node.js 20 or later.

## Install the server

On a Linux or macOS machine with Docker Engine 25 or later and its Compose plugin:

```sh
agentome install
```

It asks for the folder, the address people will open (a domain for HTTPS, or this machine only)
and whether people get their own places on the server, where their agents run with nothing
installed on their computers. Then it downloads the release's `compose.yaml`, makes a database
password of its own, starts the server and prints the address of the first-run setup with its
code. The same without questions:

```sh
agentome install --dir /srv/agentome --domain agentome.example.com --places --yes
```

Run again in the same folder, it keeps `.env` and your Caddyfile. Then, from anywhere on that
machine:

| Command                     | What it does                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `agentome status`           | What runs, its release and its address                                                                                    |
| `agentome update`           | A backup first, then the release of this program; update the program to get a newer one: `npm install -g agentome@latest` |
| `agentome backup [<file>]`  | The database, into `backups/` unless you name a file; the secret key stays out, keep a copy of it apart                   |
| `agentome logs [<service>]` | The server's logs, as they come                                                                                           |

## Connect a computer

For agents that run on a person's own computer, under their Claude or ChatGPT subscription, with
Claude Code or Codex installed and signed in:

```sh
agentome connect <code> <server>
```

The code comes from Admin, Computers, in your company's Agentome. The program downloads the
worker from your server, checks it against its checksum, connects it and starts it as a service of
your session on macOS, Linux or Windows. `agentome connect status` says what it is doing;
`agentome connect update` puts in the worker of the server's current release.

## Manage Agentome from an MCP client

Agentome's MCP lets Claude, Codex or another MCP client manage agents, teams, projects and tasks as
you. A client that calls an address connects to `https://<server>/mcp/manage` with the header
`Authorization: Bearer <token>`. One that starts a program runs this one:

```sh
AGENTOME_URL=https://agentome.example.com AGENTOME_TOKEN=<token> agentome mcp
```

The token comes from API tokens in Agentome and acts as you; a Read only token gets only the tools
that read. For Claude Desktop, put the command in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentome": {
      "command": "npx",
      "args": ["-y", "agentome", "mcp"],
      "env": { "AGENTOME_URL": "https://agentome.example.com", "AGENTOME_TOKEN": "<token>" }
    }
  }
}
```

## More

How Agentome works, how to set it up and run it: [agentome.ai](https://agentome.ai) and
[github.com/agentome-ai/agentome](https://github.com/agentome-ai/agentome). Licensed under the
[Elastic License 2.0](https://github.com/agentome-ai/agentome/blob/main/LICENSE).
