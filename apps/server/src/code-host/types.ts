import type { CodeHostKind } from '@agentome/shared';

// One interface over GitHub and GitLab, in our words: a change request is
// a pull request or a merge request, and nothing above this layer knows which host answered.

/** A repository of a connection, by the URL a task names. */
export interface RepositoryRef {
  /** `owner/name` on GitHub, the full path on GitLab: what the host's API takes. */
  readonly path: string;
  /** Where git clones from, through the git proxy. */
  readonly cloneUrl: string;
  /** Where a person opens it. */
  readonly webUrl: string;
  readonly defaultBranch: string;
}

export type ChangeRequestState = 'open' | 'draft' | 'merged' | 'closed';
/** The CI of a change request's head, as a person reads it. */
export type PipelineState = 'none' | 'running' | 'success' | 'failed';

export interface ChangeRequest {
  /** The number people say out loud: #42 on GitHub, !42 on GitLab. */
  readonly number: number;
  readonly title: string;
  readonly state: ChangeRequestState;
  readonly url: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly pipeline: PipelineState;
}

/** A job the pipeline failed on, with the tail of its log. */
export interface PipelineFailure {
  readonly job: string;
  readonly url: string;
  /** The last bytes of the log, never the whole of it. */
  readonly log: string;
}

/** Where a review of a change request stands, by its latest word. */
export type ReviewState = 'approved' | 'changes_requested' | 'commented';

/**
 * A host's webhook, in our words: which change requests it is about, by their web
 * address, and what it says of them. A pipeline can be about several at once.
 */
export interface WebhookEvent {
  readonly changeRequests: readonly string[];
  readonly update: {
    readonly state?: ChangeRequestState;
    readonly pipeline?: PipelineState;
    readonly review?: ReviewState;
  };
  /** A change request opened, or marked ready: what a reviewer agent is given. */
  readonly opened?: {
    readonly title: string;
    readonly author: string;
    readonly repository: string;
  };
  /** Who reviewed or commented: the connection's own account starts nothing. */
  readonly actor?: string;
}

/** A file of a branch: its path, and the id of its content, which changes when the text does. */
export interface TreeFile {
  readonly path: string;
  readonly sha: string;
}

export interface CodeHost {
  readonly kind: CodeHostKind;
  /** What a person calls a change request here, for a message an agent or a screen shows. */
  readonly changeRequestWord: string;
  /** Whose account this token is: the name a change request will carry. */
  probe(): Promise<{ login: string }>;
  repository(url: string): Promise<RepositoryRef>;
  createBranch(repository: string, branch: string, from: string): Promise<void>;
  openChangeRequest(input: {
    repository: string;
    title: string;
    description: string;
    sourceBranch: string;
    targetBranch?: string;
    draft?: boolean;
  }): Promise<ChangeRequest>;
  getChangeRequest(repository: string, number: number): Promise<ChangeRequest>;
  getPipelineFailures(repository: string, number: number): Promise<PipelineFailure[]>;
  replyToReview(input: {
    repository: string;
    number: number;
    body: string;
  }): Promise<{ url: string }>;
  /**
   * The files of a branch, each with the id of its content, for the knowledge sync;
   * `truncated` when the host would not list them all.
   */
  tree(repository: string, ref: string): Promise<{ files: TreeFile[]; truncated: boolean }>;
  /** One file's text, by the id `tree` gave it. */
  file(repository: string, sha: string): Promise<string>;
  /** How much `head` changes against `base`, and where a person reads the comparison. */
  compare(
    repository: string,
    base: string,
    head: string,
  ): Promise<{ additions: number; deletions: number; files: number; url: string }>;
  /** Whether `older` is an ancestor of `newer`: the git proxy refuses a push that is not. */
  isAncestor(repository: string, older: string, newer: string): Promise<boolean>;
  /**
   * A webhook body the route has verified, by the event its header named: null for an event
   * this platform does nothing with, or a body without what it needs.
   */
  parseWebhook(event: string, body: unknown): WebhookEvent | null;
  /** What the proxy gives git as a password, and under which name. */
  gitCredential(): { username: string; password: string };
}
