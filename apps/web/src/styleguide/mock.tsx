import type { AgentSheetProps } from '../agent-sheet/agent-sheet';
import type { ShellData } from '../shell/app-shell';

// The approved preview's data (docs/design/preview.html), for the dev-only styleguide.

export const shell: ShellData = {
  approvalsWaiting: 3,
  tasksInWork: 2,
  agents: [
    { id: 'reviewer', name: 'Reviewer', status: 'waiting_approval' },
    { id: 'release-notes', name: 'Release notes writer', status: 'running' },
    { id: 'backend-dev', name: 'Backend developer' },
  ],
  user: { name: 'Maria Ivanova' },
};

export const backendDeveloper: AgentSheetProps = {
  id: '7f3a9c21',
  name: 'Backend developer',
  roleTitle: 'Senior backend engineer, Payments',
  owner: 'Maria Ivanova',
  since: '12 Mar 2026',
  template: { name: 'Backend developer', version: 3 },
  lastRun: { status: 'done', when: '2 h ago' },
  seat: { name: 'Maria’s laptop', state: 'busy', activity: 'Running Release notes writer' },
  projects: [
    { name: 'Payments API', host: 'gitlab', repository: 'payments/payments-api' },
    { name: 'Billing service', host: 'github', repository: 'northfold/billing-service' },
  ],
  connectors: [
    {
      name: 'Code host',
      hosts: ['gitlab', 'github'],
      tools: [
        {
          action: (
            <>
              Create <code>agent/*</code> branches
            </>
          ),
          policy: 'allow',
        },
        { action: 'Read failed pipeline jobs', policy: 'allow' },
        { action: 'Reply to review comments', policy: 'allow' },
        { action: 'Open a merge request or pull request', policy: 'ask' },
        { action: 'Push to main or force-push', policy: 'deny', platformRule: true },
      ],
    },
    {
      name: 'Jira',
      tools: [
        { action: 'Read issues and their comments', policy: 'allow' },
        { action: 'Comment on an issue', policy: 'ask', unsaved: true },
        { action: 'Move an issue to another status', policy: 'ask' },
      ],
    },
    {
      name: 'Knowledge',
      tools: [{ action: 'Search and read project knowledge', policy: 'allow' }],
    },
    { name: 'Memory', tools: [{ action: 'Read and update its memory', policy: 'allow' }] },
    {
      name: 'Workspace',
      tools: [
        { action: 'Read and edit files', policy: 'allow' },
        { action: 'Run pnpm, git and node', policy: 'allow' },
        { action: 'Fetch web pages', policy: 'deny' },
      ],
    },
  ],
  people: [
    { name: 'Maria Ivanova', level: 'owner' },
    { name: 'Ilya Smirnov', level: 'deputy', until: '3 Nov' },
    { name: 'Olga Kim', level: 'operator' },
    { name: 'Daniil Orlov', level: 'viewer' },
  ],
  budget: 250,
  spend: { month: 112.4, perTask: [2.4, 6.1], runs: 38 },
  skills: [
    { name: 'Test-driven fix', version: '1.4.0' },
    { name: 'Conventional commits', version: '2.0.1' },
    { name: 'Drizzle migrations', version: '1.1.0' },
    { name: 'Payments domain', version: '0.9.2', privateTo: 'Maria Ivanova' },
  ],
  memoryDocuments: 3,
  unsavedChanges: true,
};

/** A new agent from a template: never run, not shared, no skills yet. */
export const newAgent: AgentSheetProps = {
  ...backendDeveloper,
  id: '2c81d04e',
  name: 'QA engineer',
  roleTitle: 'Regression and end-to-end tests',
  owner: 'Ilya Smirnov',
  since: '21 Oct 2026',
  template: { name: 'QA engineer', version: 2 },
  lastRun: null,
  seat: null,
  projects: [],
  connectors: [{ name: 'Workspace', tools: [{ action: 'Read and edit files', policy: 'allow' }] }],
  people: [{ name: 'Ilya Smirnov', level: 'owner' }],
  budget: 100,
  spend: null,
  skills: [],
  memoryDocuments: 0,
  unsavedChanges: false,
};

// Status | key | task | agent | started by | computer | result | duration | cost
export const runs = `
running|PAY-412|Fix flaky retry test|Backend developer|Maria Ivanova|Maria’s computer|Turn 18 of 80|12 min|$1.84
waiting_approval|!482|Idempotency keys for refunds|Reviewer|GitLab webhook|Maria’s computer|Waiting for Maria Ivanova|4 min|$0.40
queued|BIL-91|Release notes for 2.14|Release notes writer|Schedule||Next free computer||
done|PAY-405|Retry settlement export|Backend developer|Maria Ivanova|Maria’s computer|Merge request !479|18 min|$3.92
failed|PAY-409|Fix checkout e2e suite|QA engineer|Ilya Smirnov|Ilya’s computer|Turn limit reached|22 min|$2.75
done||Weekly payments report|Analyst|Schedule|Olga’s computer|Report attached|9 min|$1.12
cancelled|BIL-87|Regenerate the API client|Backend developer|Maria Ivanova|Maria’s computer|Cancelled by Maria Ivanova|3 min|$0.21
done|PAY-401|Add refund reason codes|Backend developer|Maria Ivanova|Maria’s computer|Pull request #212|26 min|$5.40`
  .trim()
  .split('\n')
  .map((line) => line.split('|'));
