import type { Db } from '@agentome/db';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ChangeRequest, CodeHost, RepositoryRef } from '../code-host/index.js';
import { AppError } from '../errors.js';
import { addComment, getIssue, issueUrl, type JiraConnection } from '../jira/client.js';
import { readKnowledge, searchKnowledge } from '../knowledge/service.js';
import { commentAsAgent } from '../tasks/thread.js';
import {
  currentMemory,
  MemoryContent,
  MemoryPath,
  memoryVersions,
  writeMemory,
} from '../memory/service.js';

// The agent's tools. The code host's name no repository: the server takes the run's
// own, so an agent cannot point the organization's token anywhere else; the same five for GitHub
// and GitLab, in our words. The Jira's name no issue either: only the one the task came from.
// The memory's act on the run's own agent, the knowledge's on its
// projects' documents. What each returns
// is what the agent needs next, as JSON text.

/** The branches an agent makes and opens change requests from; the git proxy holds pushes to the same rule. */
const AgentBranch = z
  .string()
  .regex(/^agent\/[A-Za-z0-9._/-]{1,200}$/, 'Use a branch under agent/, such as agent/add-readme')
  .refine((name) => !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock'), {
    message: 'Use a plain branch name under agent/, without .. or a trailing slash',
  })
  .describe('A branch under agent/, such as agent/add-readme');
/** The same rule for the git proxy, on a branch name without `refs/heads/`. */
export const isAgentBranch = (name: string) => AgentBranch.safeParse(name).success;
const Number_ = z.int().positive().describe('The change request number, as #42 or !42 shows it');

/** What a tool works on. The code host is reached only by the tools that need it. */
export interface ToolContext {
  readonly db: Db;
  readonly agentId: string;
  readonly runId: string;
  /** The task's repository on its code host; throws a ToolRefusal when there is none. */
  codeHost(): Promise<{ host: CodeHost; repository: RepositoryRef }>;
  /** The Jira issue the task came from; throws a ToolRefusal for a task from anywhere else. */
  jiraIssue(): Promise<{ connection: JiraConnection; key: string }>;
}

/** A call that cannot go on, with the sentence the agent reads. */
export class ToolRefusal extends Error {}

/** What a tool did: the text the agent reads, a line for the audit, and an artifact if any. */
export interface ToolResult {
  readonly text: string;
  readonly summary: string;
  readonly changeRequest?: ChangeRequest & { host: string };
  /** A library server's answer, passed to the agent as the server gave it. */
  readonly passThrough?: CallToolResult;
  /**
   * Who wrote the text, when it is not the platform: Jira, the code host, the knowledge base, a
   * library server. The gateway marks it as data, not instructions.
   */
  readonly from?: string;
  /** Notifications the call made, for the gateway to push. */
  readonly notify?: string[];
}

export interface Tool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  /** Where the agent's sheet and policies group it: a library server's tools go under its name. */
  readonly connector: string;
  readonly title: string;
  readonly description: string;
  readonly input: Shape;
  readonly readOnly: boolean;
  run(context: ToolContext, args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
}

const tool = <Shape extends z.ZodRawShape>(definition: Tool<Shape>) => definition as Tool;
const json = (value: unknown) => JSON.stringify(value, null, 2);
const HOST_NAME = { gitlab: 'GitLab', github: 'GitHub' } as const;

/** The question to the agent's owner: its answer is the owner's, not a tool's. */
export const ASK_OWNER = 'ask_owner';

/** A lead's task for a lead under it; the tool lives with the tasks. */
export const ASSIGN_TASK = 'assign_task';

/**
 * Every agent has it and no policy changes it: the call always waits for the owner, who
 * answers in Approvals or on the task's page, and the gateway hands back the answer.
 */
export const askOwner = tool({
  connector: 'Owner',
  name: ASK_OWNER,
  title: 'Ask its owner',
  description:
    'Asks your owner a question and waits for the answer, for a decision only they can make (scope, a choice between options, what done means). They answer in Agentome; the run waits as long as its time allows. Offer options when the answer is one of a few. If nobody answers, go on with your best judgement and say so in your report.',
  input: {
    question: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe('The question, as your owner will read it'),
    options: z
      .array(z.string().trim().min(1).max(200))
      .max(6)
      .optional()
      .describe('Answers to pick from, if the answer is one of a few'),
  },
  readOnly: true,
  // The gateway answers it with the owner's words; it never runs.
  async run() {
    throw new ToolRefusal('Only your owner answers this.');
  },
});

export const TOOLS: Tool[] = [
  tool({
    connector: 'Code host',
    name: 'code_host_create_branch',
    title: 'Create a branch',
    description:
      "Creates a branch in this task's repository from another branch (the default branch when none is given). Push your commits to it, then open a change request from it.",
    input: {
      branch: AgentBranch,
      from: z.string().min(1).max(250).optional().describe('The branch to start from'),
    },
    readOnly: false,
    async run({ codeHost }, args) {
      const { host, repository } = await codeHost();
      const from = args.from ?? repository.defaultBranch;
      await host.createBranch(repository.path, args.branch, from);
      return { text: json({ branch: args.branch, from }), summary: `${args.branch} from ${from}` };
    },
  }),
  tool({
    connector: 'Code host',
    name: 'code_host_open_change_request',
    title: 'Open a change request',
    description:
      "Opens a pull request (GitHub) or merge request (GitLab) in this task's repository from a branch you pushed. It may wait for the agent's owner to approve it first.",
    input: {
      branch: AgentBranch,
      title: z.string().trim().min(1).max(250).describe('One line, as a reviewer reads it'),
      description: z.string().max(60_000).describe('What changed and why, in markdown'),
      target: z.string().min(1).max(250).optional().describe('Default: the default branch'),
      draft: z.boolean().optional().describe('Open it as a draft'),
    },
    readOnly: false,
    async run({ codeHost }, args) {
      const { host, repository } = await codeHost();
      const opened = await host.openChangeRequest({
        repository: repository.path,
        title: args.title,
        description: args.description,
        sourceBranch: args.branch,
        targetBranch: args.target,
        draft: args.draft,
      });
      return {
        text: json(opened),
        summary: opened.url,
        changeRequest: { ...opened, host: host.kind },
      };
    },
  }),
  tool({
    connector: 'Code host',
    name: 'code_host_get_change_request',
    title: 'Read a change request',
    description:
      "The state of a change request in this task's repository and of its pipeline: open, draft, merged or closed; none, running, success or failed.",
    input: { number: Number_ },
    readOnly: true,
    async run({ codeHost }, args) {
      const { host, repository } = await codeHost();
      const found = await host.getChangeRequest(repository.path, args.number);
      return {
        text: json(found),
        summary: `${found.state}, pipeline ${found.pipeline}`,
        from: HOST_NAME[host.kind],
      };
    },
  }),
  tool({
    connector: 'Code host',
    name: 'code_host_get_pipeline_failures',
    title: 'Read pipeline failures',
    description:
      'The jobs that failed in the pipeline of a change request, each with the tail of its log, to fix what broke.',
    input: { number: Number_ },
    readOnly: true,
    async run({ codeHost }, args) {
      const { host, repository } = await codeHost();
      const failures = await host.getPipelineFailures(repository.path, args.number);
      const jobs = failures.map((failure) => failure.job).join(', ');
      return {
        text: json(failures),
        summary: failures.length ? `failed: ${jobs}` : 'no failures',
        from: `${HOST_NAME[host.kind]} pipeline logs`,
      };
    },
  }),
  tool({
    connector: 'Code host',
    name: 'code_host_reply_to_review',
    title: 'Reply on a change request',
    description: 'Posts a comment on a change request, to answer a review or say what you changed.',
    input: {
      number: Number_,
      body: z.string().trim().min(1).max(60_000).describe('The comment, in markdown'),
    },
    readOnly: false,
    async run({ codeHost }, args) {
      const { host, repository } = await codeHost();
      const posted = await host.replyToReview({
        repository: repository.path,
        number: args.number,
        body: args.body,
      });
      return { text: json(posted), summary: posted.url };
    },
  }),
  tool({
    connector: 'Task',
    name: 'task_comment',
    title: 'Comment on its task',
    description:
      "Writes in the thread of this run's task, where your owner reads it and gets a notification: an answer to their comment, or a note on the way (the branch is up, waiting for CI). Not for questions you cannot go on without: ask those with ask_owner. Your report at the end of the run goes to the thread by itself.",
    input: {
      body: z.string().trim().min(1).max(20_000).describe('The comment, in markdown'),
    },
    readOnly: false,
    async run({ db, agentId, runId }, args) {
      const made = await commentAsAgent(db, runId, agentId, args.body);
      if (!made) throw new ToolRefusal('This run has no task, so there is no thread to write in.');
      return { text: 'Posted.', summary: args.body.slice(0, 200), notify: made.notifications };
    },
  }),
  tool({
    connector: 'Memory',
    name: 'memory_read',
    title: 'Read its memory',
    description:
      'Without a path: the documents of your memory, each with its version. With a path: that document and its version. The same files are in your profile, as they were when the run started.',
    input: { path: MemoryPath.optional().describe('MEMORY.md or memory/<name>.md') },
    readOnly: true,
    async run({ db, agentId }, args) {
      if (!args.path) {
        const documents = await currentMemory(db, agentId);
        const list = documents.map(({ path, version, content }) => ({
          path,
          version,
          characters: content.length,
        }));
        return { text: json(list), summary: `${list.length} documents` };
      }
      // No such document is the agent's mistake, said as one; anything else is the server's.
      const [latest] = await memoryVersions(db, agentId, args.path).catch((error: unknown) => {
        if (error instanceof AppError && error.code === 'not_found') return [];
        throw error;
      });
      if (!latest?.content) throw new ToolRefusal(`Your memory has no ${args.path}.`);
      return {
        text: json({ path: latest.path, version: latest.version, content: latest.content }),
        summary: `${latest.path} v${latest.version}`,
      };
    },
  }),
  tool({
    connector: 'Memory',
    name: 'memory_write',
    title: 'Write to its memory',
    description:
      'Saves a document of your memory as a new version, for your later runs and your owner to read: the whole new text, not a change. Give the version you read as baseVersion, and the write is refused if someone changed it since.',
    input: {
      path: MemoryPath.describe('MEMORY.md or memory/<name>.md'),
      content: MemoryContent.min(1).describe('The whole document, in markdown'),
      baseVersion: z.int().min(0).optional().describe('The version you read; 0 for a new document'),
    },
    readOnly: false,
    async run({ db, agentId, runId }, args) {
      const written = await writeMemory(db, { agentId, ...args, author: { runId } }).catch(
        (error: unknown) => {
          if (error instanceof AppError && error.code === 'memory_conflict') {
            throw new ToolRefusal(`${error.message} Read it again with memory_read.`);
          }
          throw error;
        },
      );
      return {
        text: json({ path: written.path, version: written.version }),
        summary: `${written.path} v${written.version}`,
      };
    },
  }),
  tool({
    connector: 'Knowledge',
    name: 'knowledge_search',
    title: 'Search the knowledge',
    description:
      'Searches the documentation of your projects (markdown from their repositories, as of the last sync) by words, best matches first, each with a snippet. Read a whole document with knowledge_read and its id.',
    input: {
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe('Words to look for, such as refund webhook'),
      limit: z.int().min(1).max(20).optional().describe('How many results; 10 when not given'),
    },
    readOnly: true,
    async run({ db, agentId }, args) {
      const found = await searchKnowledge(db, agentId, args.query, args.limit ?? 10);
      return {
        text: json(found),
        summary: `${found.length} found for ${args.query}`,
        from: 'the knowledge base',
      };
    },
  }),
  tool({
    connector: 'Knowledge',
    name: 'knowledge_read',
    title: 'Read a knowledge document',
    description:
      'One document of your projects’ knowledge, whole, by the id knowledge_search gave.',
    input: { id: z.uuid().describe('The id from knowledge_search') },
    readOnly: true,
    async run({ db, agentId }, args) {
      const found = await readKnowledge(db, agentId, args.id);
      if (!found) throw new ToolRefusal('No document of your projects has this id. Search again.');
      return {
        text: json(found),
        summary: `${found.path} in ${found.repository}`,
        from: 'the knowledge base',
      };
    },
  }),
  tool({
    connector: 'Jira',
    name: 'jira_get_issue',
    title: 'Read the Jira issue',
    description:
      "The Jira issue this task came from, as it is now: key, summary, description (Jira's wiki markup), status and link.",
    input: {},
    readOnly: true,
    async run({ jiraIssue }) {
      const { connection, key } = await jiraIssue();
      const issue = await getIssue(connection, key);
      const found = { ...issue, url: issueUrl(connection, key) };
      return { text: json(found), summary: `${issue.key}, ${issue.status}`, from: 'Jira' };
    },
  }),
  tool({
    connector: 'Jira',
    name: 'jira_add_comment',
    title: 'Comment on the Jira issue',
    description:
      "Adds a comment to the Jira issue this task came from, in Jira's wiki markup: a question for the reporter, or what you found. It may wait for the agent's owner to approve it first.",
    input: { body: z.string().trim().min(1).max(30_000).describe('The comment') },
    readOnly: false,
    async run({ jiraIssue }, args) {
      const { connection, key } = await jiraIssue();
      const made = await addComment(connection, key, args.body);
      return { text: json({ issue: key, comment: made.id }), summary: `comment on ${key}` };
    },
  }),
];
