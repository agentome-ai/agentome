# API

Everything the web app does goes through Agentome's HTTP API, so a script, a CI job or another
system can do it too: file a task when something happens elsewhere, follow its run, decide an
approval, set up agents and projects. This page shows how to sign in and make the first calls; the
[API reference](https://agentome.ai/docs/api/reference/) lists every call.

## Sign in with a token

Calls sign in with a personal API token, which acts as you: what you can do in the web app, the
token can do, or only read if you made it **Read only**. Make one under your name, **API tokens**
(see [Make a token](administration.md#make-a-token)), and send it in the `Authorization` header.

Keep the address of your installation and the token in the environment, so neither ends up in a
script:

```sh
export AGENTOME_URL=https://agentome.example.com
export AGENTOME_TOKEN=<the token>
```

Check that it works by asking who you are:

```sh
curl -s "$AGENTOME_URL/api/me" -H "Authorization: Bearer $AGENTOME_TOKEN"
```

A few calls that handle secrets answer only in the browser: making tokens, invitations and pairing
codes, setting the keys of model and code-host connections, places on the server and notifications.
A token that leaks cannot make more of itself or put a key of its own in place.

## File a task and follow its run

Find the project and the agent, by name, in the lists:

```sh
curl -s "$AGENTOME_URL/api/projects" -H "Authorization: Bearer $AGENTOME_TOKEN"
curl -s "$AGENTOME_URL/api/agents" -H "Authorization: Bearer $AGENTOME_TOKEN"
```

Then file the task. Without `agentId` it goes to the lead of the project's team; with `run: false`
it waits until someone starts it.

```sh
curl -s "$AGENTOME_URL/api/tasks" \
  -H "Authorization: Bearer $AGENTOME_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "<project id>",
    "agentId": "<agent id>",
    "title": "Add a dark theme to the settings page",
    "body": "The settings page ignores the dark theme. Match the rest of the app."
  }'
```

The answer has the `task` and its queued `run`. Read the run until its `status` is no longer
`queued` or `running`:

```sh
curl -s "$AGENTOME_URL/api/runs/<run id>" -H "Authorization: Bearer $AGENTOME_TOKEN"
```

Or follow it as it goes: `/api/runs/<run id>/stream` sends the run's events as server-sent events
until it ends, each as a `run` event, and its status as a `status` event.

```sh
curl -sN "$AGENTOME_URL/api/runs/<run id>/stream" -H "Authorization: Bearer $AGENTOME_TOKEN"
```

When the run is done, the task is in **Review**: `GET /api/tasks/<task id>` has its runs, comments
and change requests, and `POST /api/tasks/<task id>/comments` asks for changes.

## Decide approvals

`GET /api/approvals` lists the tool calls that wait for you, oldest first. Each one is decided with
`POST /api/tool-calls/<id>/approve` or `/deny`, and an agent's question is answered with `/answer`.
Only the agent's owner decides.

## Errors

A refused call answers with its HTTP status and a body like this one, whose `message` is written for
a person:

```json
{ "error": { "code": "not_found", "message": "Task not found" } }
```

| Status | What it means                                                                       |
| ------ | ----------------------------------------------------------------------------------- |
| 400    | The body or a parameter is not what the call takes; `details` says which            |
| 401    | No token, or one that has expired or was revoked                                    |
| 403    | The token cannot do this: it only reads, the call needs the browser, or you may not |
| 404    | Nothing with that id, or nothing you may see                                        |
| 409    | The state does not allow it now, such as a run that is already going                |
| 502    | A code host, a model connection or a place did not answer                           |

## The description

Each server describes its own API at `/openapi.json`, as OpenAPI 3, at the version it runs. Import
it into Postman or Insomnia, or generate a client from it. The
[reference on this site](https://agentome.ai/docs/api/reference/) is written from the description of
the latest release.

To manage agents, teams and projects from Claude Code or Codex in your own words rather than with
calls, connect them to Agentome as an MCP server: see
[API tokens and managing Agentome from Claude Code or Codex](administration.md#api-tokens-and-managing-agentome-from-claude-code-or-codex).
