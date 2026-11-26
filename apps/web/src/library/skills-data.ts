// The skills of the library as the pages read them.
export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  version: number;
  owner: { id: string; name: string } | null;
  visibility: 'org' | 'private';
  /** How many files the version brings beside its SKILL.md, and their size in bytes. */
  fileCount: number;
  fileBytes: number;
  createdAt: string;
};
export type Skill = SkillSummary & { content: string; files: { path: string; size: number }[] };

/**
 * An agent's skill as its view lists it: the pinned version, whose it is if private, and
 * whether it brings files, which an export leaves behind.
 */
export type AgentSkill = {
  id: string;
  name: string;
  version: string;
  privateTo?: string;
  withFiles?: boolean;
};

/** A remote MCP server of the library, with the tools it listed at its last check. */
export type McpServer = {
  id: string;
  name: string;
  description: string;
  url: string;
  hasAuthorization: boolean;
  /** A fixed header, or each person's OAuth sign-in. */
  auth: 'header' | 'oauth';
  /** Whether the person looking has signed in, for an OAuth server. */
  signedIn: boolean;
  tools: { name: string; title: string; description: string }[];
  checkedAt: string;
  owner: { id: string; name: string } | null;
  visibility: 'org' | 'private';
};
export type AgentMcpServer = { id: string; name: string; privateTo?: string };
