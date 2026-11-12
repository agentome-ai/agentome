// The skills of the library as the pages read them.
export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  version: number;
  owner: { id: string; name: string } | null;
  visibility: 'org' | 'private';
  createdAt: string;
};
export type Skill = SkillSummary & { content: string };

/** An agent's skill as its view lists it: the pinned version, and whose it is if private. */
export type AgentSkill = { id: string; name: string; version: string; privateTo?: string };

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
