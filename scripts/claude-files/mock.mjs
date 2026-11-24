// A stand-in for Anthropic's Messages API, for scripts/check-claude-files.sh: it asks Claude Code
// for a fixed list of tool calls, one a turn, and then ends. No model: what each tool did comes
// back in the CLI's own stream-json. STEPS is a JSON list of [tool, input].
/* global process */
import { createServer } from 'node:http';

const steps = JSON.parse(process.env.STEPS ?? '[]');
const usage = { input_tokens: 1, output_tokens: 1 };

function send(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, data] of events) {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }
  response.end();
}

createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"input_tokens":1}');
      return;
    }
    const asked = JSON.parse(body || '{}');
    // How far it got: one tool result a turn.
    const done = (asked.messages ?? []).flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'tool_result')
        : [],
    ).length;
    const message = { id: `msg_${done}`, type: 'message', role: 'assistant', model: asked.model };
    const start = ['message_start', { message: { ...message, content: [], usage } }];
    if (!asked.tools || done >= steps.length) {
      send(response, [
        start,
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'done' } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'end_turn' }, usage }],
        ['message_stop', {}],
      ]);
      return;
    }
    const [name, input] = steps[done];
    const block = { type: 'tool_use', id: `toolu_${done}`, name, input: {} };
    send(response, [
      start,
      ['content_block_start', { index: 0, content_block: block }],
      [
        'content_block_delta',
        { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
      ],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'tool_use' }, usage }],
      ['message_stop', {}],
    ]);
  });
}).listen(8787, '127.0.0.1');
