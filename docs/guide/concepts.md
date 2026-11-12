# Concepts

This page explains the words Agentome uses and how the things they name fit together. Each term has
a short definition and a paragraph on how it relates to the rest. For a hands-on start, see
[Getting started](getting-started.md).

## The short version

An **agent** is an AI employee that the company owns, in any role: what it can do comes from its
skills and tools. It has an **owner**, a person who answers for it. It works on the **tasks** of the
**projects** it is on, in their **repositories**. Each attempt at a task is a **run**, which happens
in its owner's **place** on the server or on their **computer**, or on a **server seat**. During a run, the agent's tools go through the
**MCP gateway** and its pushes through the **git proxy**, and each tool call follows the agent's
**policy**: allowed, asked, or denied. A call that asks waits for an **approval**. Between runs the
agent keeps **memory**; it brings **skills** from the **library**, and reads the project's
**knowledge**. Agents can work together as a **team**.

## Agent

An AI agent with a role, instructions, skills, tools, memory, limits and an owner, kept on the
Agentome server.

You create an agent from a role template or from a blank one in **Agents**, and shape it in its
editor: **Identity**, **Instructions**, **Skills**, **Team**, **Tools & policies**, **Memory**,
**Schedules**, **Access**, **Budget**, **Engine & model** and **Quality**. The engine is the CLI
that does the work, Claude Code or Codex. An agent belongs to the platform, not to a machine: the
same agent can run on different computers, and when its owner changes, it keeps its memory and
history. An agent you no longer need can be archived and brought back later. Free allows up to five
active agents; more need a license key. See [Agents](agents.md).

## Owner

The person an agent belongs to and who answers for it.

The person who creates an agent is its owner. Only its owner opens and runs it, approves what its
policies ask, and answers its questions. When the agent works on a person's computer, it is its
owner's computer and its owner's subscription. Its sheet shows the owner.

## Access

Who can open and run an agent.

An agent's **Access** section lists its owner, and says "Only its owner can open and run this
agent." Admins see everything in the admin views. To let someone else work with an agent, you
transfer it: **Transfer ownership** on the agent's sheet hands it to a **New owner**, for good or
until a date (**Comes back**), when it returns by itself. Its memory, history and settings go with
it, and if it leads a team, the whole team goes too. This is how an agent keeps working while its
owner is on holiday or after they leave. See [Agents](agents.md).

## Project

The place where tasks are filed, and what an agent may reach.

A project has a name, a description and goals that agents read with each task, its **Agents**, its
**Repositories**, its **Knowledge**, and its connections to a code host or Jira. Every task is filed
in a project, and only the project's agents work on its tasks. A project may name a team that takes
its tasks, and whether a person starts each new task or the team's lead starts it at once. Any
signed-in person can create a project; its maker and the admins change it. A person puts only their
own agents on a project; an admin can put any agent on any project. A monthly limit on what the
project's runs cost needs a license key. See [Projects and tasks](projects-and-tasks.md).

## Repository

A GitHub or GitLab repository a project's agents work in.

An admin adds a project's repositories after connecting the project to the code host. The first one
is the main one: a task starts there unless it names another, and tasks from Jira start there. A
task can also work in a folder on the computer that runs it, or in a new, empty folder each run.
Agents never get the code host's token: they clone and push through the git proxy and open merge or
pull requests through the MCP gateway, acting as the account of the project's connection.

## Task

A piece of work for an agent or a team, filed in a project.

A task has a title, a description in Markdown, the project, the agent or team that does it, and
where it works. It is **Open** until a run of it ends **Done**, then **In review** until a person
marks it **Done** or runs it again. While a run goes, the task shows the run's status instead:
**Queued**, **Running** or **Waiting for you**. Comments on a task go to its next run. Tasks come
from people, from an agent's schedules, from Jira issues, and from a lead handing a task to a team
under it. See [Projects and tasks](projects-and-tasks.md).

## Run

One attempt of an agent at a task, from start to finish.

A run is **Queued** until a place, a computer or a server seat picks it up, then **Running**, possibly
**Waiting approval** while a call waits for a person, and ends **Done**, **Failed** or
**Cancelled**. It keeps its plan, its transcript, the tool calls it made and what it cost. It ends
with artifacts: a report, a branch, and a merge or pull request when the agent opened one. Each run
is held to limits: minutes, turns and tokens per run, set in the agent's **Budget** or by the
platform's defaults. Running a task again starts a new run, which reads the comments since the last
one.

## Team

A lead agent with member agents, which splits a task between them.

A team takes tasks through its lead. The lead splits a task into steps and hands them to its
members, which work as subagents inside the lead's single run, on the same branch. Either the lead
decides who works on what (**The lead decides**), or you set the steps yourself (**Steps you set**),
each with a line that says what done looks like. An agent leads one team at most, and a Codex agent
leads no team. Teams nest: put the lead of another team in a team, and its lead hands that team
whole tasks. You arrange them by dragging on the **Teams** chart. Free allows one team; more teams,
and nested teams, need a license key. See [Teams](teams.md).

## Place

A person's own container on the company's server, made by the platform, that runs their agents.

A place runs the worker under the person's own Claude or ChatGPT subscription, which they sign in to
once in its terminal in the browser. It takes runs only while the person has Agentome open and in
use, and sleeps when nothing runs. It keeps the sign-in and each agent's working folder per
repository between runs, runs the services a project's devcontainer lists beside the agent once an
admin approves them, and reaches nothing outside but Agentome, the model's vendor and the hosts a
project allows. Nothing is installed on the person's computer. See
[Where agents run](computers.md#a-place-on-the-server).

## Computer

A person's work machine, connected to Agentome, that runs their agents.

A computer runs the worker, a small program that asks the server for runs of its owner's agents and
runs them with Claude Code or Codex under the person's own subscription. It takes runs only while
the person is signed in and using it, one at a time, and keeps nothing of an agent after a run. You
connect a computer once, with a one-time command from **Admin → Computers**, which also shows
whether each computer is online and what it does. In the API a computer is called a seat. See
[Where agents run](computers.md).

## Server seat

A worker in a container on the server that runs agents by themselves, with an API key.

An agent set to work on the server runs on a server seat instead of its owner's computer. The seat
uses the API key of a model connection, needs nobody at a keyboard, and takes one run at a time in a
clean container. Tool calls marked **Ask** still wait for a person. An admin starts it. Needs a
license key. See [The server seat](computers.md#the-server-seat).

## Policy

What an agent may do with each of its tools: allow, ask, or deny.

In the agent's **Tools & policies**, each tool has **Allow** (it runs without asking), **Ask** (the
call waits for the owner's approval) or **Deny** (the agent cannot call it). **Auto** allows every
tool and **Manual** asks for every tool, except the ones you deny. Working in its own folder is
always allowed. A policy is a rule on a tool call, not a step in a workflow: the agent works on
until it reaches a call that asks. See [Approvals and control](approvals-and-control.md).

## Approval

A person's answer to a tool call that a policy marks **Ask**.

The call waits in **Approvals**, with what the agent wants to do and the run so far, until the owner
clicks **Approve** or **Deny**; **Approve and stop asking** also allows that tool from then on. The
same request shows on the run and the task. An agent can also ask its owner a question mid-run,
which waits in **Approvals** for an answer. Approvals can reach a phone as push notifications. The
time a run waits for an answer does not count against its time limit. See
[Approvals and control](approvals-and-control.md).

## MCP gateway

The server's single door for an agent's tools.

During a run, the only MCP server the agent's engine gets is the Agentome gateway, opened by a token
that lives as long as the run. Through it the agent works with the code host (branches, merge or
pull requests, pipelines, reviews), comments on its task, reads and writes its memory, searches the
project's knowledge, reads and comments on its Jira issue, and calls the MCP servers from the
library it was given. The gateway applies the agent's policies to every call, and the integration
tokens stay on the server.

## Git proxy

The server's door for an agent's `git` traffic.

An agent clones a connected repository from the git proxy and pushes back through it, with a
password that works only for that repository while the run is live. The proxy accepts pushes only to
branches under `agent/`, and never deletes a branch, so an agent cannot overwrite anyone's branch.
The code host's token never leaves the server.

## Memory

What an agent writes down for its later runs.

An agent reads and writes its memory through the gateway, and it carries what the agent learned from
one run to the next. You can read it in the agent's **Memory** section and add a note for it
yourself. Every version is kept, with who wrote it and when, so you can see what changed. Memory
belongs to the agent and goes with it when it changes owner.

## Skills

Reusable instructions for a kind of work, given to an agent.

A skill is a `SKILL.md` file: its frontmatter names the skill and says what it is for, and its body
says how to do it. You add skills to the library and give them to agents in the agent's **Skills**
section. Each change to a skill is saved as a new version.

## Library

The shared shelf of skills and MCP servers.

The **Library** holds **Skills** and **MCP servers**. What you add is yours alone until an admin
shares it with everyone; then everyone can give it to their agents. Some skills come with Agentome.
An MCP server in the library can sign each person in with OAuth. You give an agent MCP servers in
its **Tools & policies**, and each of their tools gets a policy like any other. See
[Integrations](integrations.md).

## Connection

A link from Agentome to another system, with the token or key it uses.

There are two kinds. A code host or Jira connection, made by an admin in **Admin → Connections**,
links a project to GitHub, GitLab or Jira Data Center; agents of the project act as the account its
token belongs to. A model connection, made by an admin in **Admin → Models**, gives agents on the
server Anthropic, OpenAI or a gateway such as LiteLLM, with an API key. Agents on people's computers
need no model connection: they use the person's subscription. Tokens and keys are kept encrypted on
the server and never reach a computer. See [Integrations](integrations.md).

## Knowledge

A project's documentation, read from the Markdown in its repositories.

In the project's **Knowledge** section, an admin adds a source: a repository of the project and the
paths of its Markdown files. The server reads them through the project's connection and syncs them
every hour. The project's agents search and read these documents through the gateway, so they work
from the team's own docs without cloning them.

## How it fits together

A person creates an agent and puts it on a project. Someone files a task in that project for the
agent, or for a team whose lead splits it. A run starts in the place of the agent's owner, or on a
computer they connected, while the owner is at work, or on the server seat when the agent works by
itself. The worker clones
the task's repository through the git proxy, and the engine works there with the instructions,
skills and memory the platform hands it. Every tool call goes through the MCP gateway, which applies
the agent's policy; a call that asks waits in **Approvals**. When the run ends, its report, branch
and change request are on the task, the task waits in review, and the agent's memory carries what it
learned to the next run. Everything the agent is and did stays on the Agentome server.

## Free and Enterprise

Agentome is free to use without a license key. A key adds:

- more than five active agents,
- more than one team, and nested teams,
- agents on the server,
- monthly budgets for agents and projects,
- an agent's quality over 30 days,
- sign-in with Keycloak.

An admin pastes a key in **Admin → License**. See [Administration](administration.md).
