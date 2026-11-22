import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { bridge, manageUrl, sseData } from './mcp.js';
import { Refusal } from './system.js';

// `agentome mcp` between a client of the test's own on stdin and stdout and a server that answers
// as /mcp/manage does: an event stream for a request, 202 for a notification.

function run(lines: string[], answer: (body: string) => Response | Promise<Response>) {
  const sent: { url: string; init: RequestInit }[] = [];
  const out: string[] = [];
  const logged: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return answer(String(init.body));
  }) as typeof fetch;
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      out.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      done();
    },
  });
  const finished = bridge({
    url: 'https://agentome.example.com',
    token: 'the-token',
    fetch: fetchImpl,
    input: Readable.from(lines.map((line) => `${line}\n`)),
    output,
    log: (line) => logged.push(line),
  });
  return finished.then(() => ({
    sent,
    out: out.map((line) => JSON.parse(line) as Record<string, unknown>),
    logged,
  }));
}

const request = (id: number, method = 'tools/list') =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: {} });

describe('agentome mcp', () => {
  it('sends each message to /mcp/manage with the token and writes the events it answers', async () => {
    const { sent, out } = await run([request(1)], (body) => {
      const { id } = JSON.parse(body) as { id: number };
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    expect(sent[0]?.url).toBe('https://agentome.example.com/mcp/manage');
    expect(new Headers(sent[0]?.init.headers).get('authorization')).toBe('Bearer the-token');
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: { tools: [] } }]);
  });

  it('writes a JSON answer as it is, and nothing for a notification', async () => {
    const { out } = await run(
      [request(2), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })],
      (body) =>
        (JSON.parse(body) as { id?: number }).id === undefined
          ? new Response(null, { status: 202 })
          : Response.json({ jsonrpc: '2.0', id: 2, result: {} }),
    );
    expect(out).toEqual([{ jsonrpc: '2.0', id: 2, result: {} }]);
  });

  it("answers a request the server refused with the server's words", async () => {
    const { out, logged } = await run([request(3)], () =>
      Response.json(
        {
          error: {
            code: 'unauthorized',
            message: 'This token is not valid, has expired or was revoked',
          },
        },
        { status: 401 },
      ),
    );
    expect(out).toEqual([
      {
        jsonrpc: '2.0',
        id: 3,
        error: { code: -32000, message: 'This token is not valid, has expired or was revoked' },
      },
    ]);
    expect(logged[0]).toContain('has expired');
  });

  it('answers when the server cannot be reached, and a line that is not JSON', async () => {
    const { out } = await run([request(4), '{not json'], () => {
      throw new TypeError('fetch failed');
    });
    expect(out).toContainEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    expect(out).toContainEqual(
      expect.objectContaining({ id: 4, error: expect.objectContaining({ code: -32000 }) }),
    );
  });

  it('takes the server or its /mcp/manage, over https, or http on this machine', () => {
    expect(manageUrl('https://a.example.com/')).toBe('https://a.example.com/mcp/manage');
    expect(manageUrl('https://a.example.com/mcp/manage')).toBe('https://a.example.com/mcp/manage');
    expect(() => manageUrl('ftp://a.example.com')).toThrow(Refusal);
    expect(() => manageUrl('a.example.com')).toThrow(Refusal);
    // http:// carries the token in the clear: this machine only.
    expect(() => manageUrl('http://a.example.com')).toThrow(Refusal);
    expect(() => manageUrl('http://10.0.0.5:3000')).toThrow(Refusal);
    expect(manageUrl('http://localhost:3000')).toBe('http://localhost:3000/mcp/manage');
    expect(manageUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/mcp/manage');
  });

  it('reads the data of each event of a stream', () => {
    expect(sseData('event: message\ndata: {"a":1}\n\nid: 2\ndata: {"b":2}\n\n')).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });
});
