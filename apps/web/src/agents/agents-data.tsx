import type { AgentMcpServer, AgentSkill } from '../library/skills-data';
import type { Host } from '../ui/host-glyph';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, asApiError } from '../api';
import type { RunStatus } from '../ui/status';

// The agents API as the pages read it.

export type LastRun = {
  id: string;
  taskId: string | null;
  status: RunStatus;
  at: string;
  /** The run's task and its project's name; the list has it, an agent's own page does not. */
  task?: { title: string; project: string | null } | null;
} | null;

/** Runs queued, their priced cost, how many ended and were done, the median run, runs per day. */
export type AgentWeek = {
  runs: number;
  usd: string | null;
  ended: number;
  done: number;
  medianSeconds: number | null;
  daily: number[];
};

export type AgentSummary = {
  id: string;
  name: string;
  roleTitle: string;
  status: 'active' | 'archived';
  owner: { id: string; name: string };
  lastRun: LastRun;
  createdAt: string;
  /** The list only (GET /api/agents): the agent's model, and its last seven days. */
  modelPref?: string | null;
  week?: AgentWeek;
  /** The list only: the last 30 days' tasks accepted of those handed over, and the median task. */
  month?: { accepted: number; handed: number; medianUsd: string | null };
};

export type Budget = {
  maxMinutes?: number;
  maxTurns?: number;
  maxTokens?: number;
  usdPerMonth?: number;
};

export type Agent = AgentSummary & {
  instructions: string;
  engine: 'claude-code' | 'codex';
  modelPref: string | null;
  /** Where its runs go; on a server, the model connection they take a model from. */
  runsOn: 'laptop' | 'server';
  modelConnection: { id: string; name: string } | null;
  serverShell: boolean;
  budget: Budget | null;
  runDefaults: { maxMinutes: number; maxTurns: number; maxTokens: number };
  copiedFromAgentId: string | null;
  template: { id: string; name: string; version: number } | null;
  seat: { id: string; name: string; busy: boolean; lastSeenAt: string | null } | null;
  /** `validUntil`: has the agent until then; `validFrom`: the owner it goes back to on that day. */
  people: {
    id: string;
    name: string;
    level: 'owner';
    validFrom: string | null;
    validUntil: string | null;
  }[];
  tools: { connector: string; name: string; title: string; policy: 'allow' | 'ask' | 'deny' }[];
  memoryDocuments: number;
  /** This calendar month against the monthly limit; runs stop once it is reached. */
  spend: { usdThisMonth: number; limit: number | null; reached: boolean; resumed: boolean };
  /** The skills the agent was given, at their pinned versions. */
  skills: AgentSkill[];
  mcpServers: AgentMcpServer[];
  /** The projects this agent works on, each with its code hosts and repositories, main first. */
  projects: { id: string; name: string; hosts: Host[]; repositories: string[] }[];
};

export type Template = {
  id: string;
  name: string;
  version: number;
  description: string;
  roleTitle: string;
  modelPref: string | null;
};

/** What Claude Code takes as --model; each one is priced in packages/costs/prices.json. */
export const models = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
];

/** What Codex takes as --model on a computer, under the person's ChatGPT sign-in. */
export const codexModels = [
  { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
  { id: 'gpt-5', name: 'GPT-5' },
];

// The sidebar lists an agent only while it needs a look: its run is alive, waits for a person or
// failed. The rest are on Agents and in ⌘K.
const shown: RunStatus[] = ['queued', 'running', 'waiting_approval', 'failed'];
export const sidebarStatus = (run: LastRun) =>
  run && shown.includes(run.status) ? run.status : undefined;

type AgentsState = { agents: AgentSummary[]; reload: () => Promise<void> };
const AgentsContext = createContext<AgentsState | null>(null);

// Runs start and end on their own, so the sidebar refreshes itself, as the seats do.
const REFRESH_MS = 30_000;

/** The person's active agents for the sidebar; pages that change an agent call reload. */
export function AgentsProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const reload = useCallback(
    () =>
      api<{ agents: AgentSummary[] }>('/api/agents').then(
        (data) => setAgents(data.agents),
        // A failed refresh keeps the list the sidebar had, unless the session has ended; the
        // pages report errors themselves.
        (error: unknown) => {
          if (asApiError(error).code === 'unauthorized') setAgents([]);
        },
      ),
    [],
  );
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);
  return <AgentsContext value={{ agents, reload }}>{children}</AgentsContext>;
}

export function useAgents(): AgentsState {
  const agents = useContext(AgentsContext);
  if (!agents) throw new Error('useAgents needs an AgentsProvider above it');
  return agents;
}
