import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Meter, metering } from './meter.js';

async function through(provider: 'anthropic' | 'openai', stream: boolean, text: string[]) {
  const meter = new Meter(provider);
  let ended = false;
  const out: string[] = [];
  await new Promise<void>((resolve, reject) => {
    Readable.from(text.map((part) => Buffer.from(part)))
      .pipe(metering(meter, stream, () => (ended = true)))
      .on('data', (chunk: Buffer) => out.push(chunk.toString()))
      .on('end', resolve)
      .on('error', reject);
  });
  // What passes is what came.
  expect(out.join('')).toBe(text.join(''));
  expect(ended).toBe(true);
  return meter.done('asked-model');
}

describe('what a provider says a call used', () => {
  it("is read from Anthropic's stream: the input at the start, the output at its last delta", async () => {
    const counted = await through('anthropic', true, [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":120,"cache_read_input_tokens":3000,"cache_creation_input_tokens":40,"output_tokens":1}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tok',
      'ens":15}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    expect(counted).toEqual({
      model: 'claude-sonnet-4-5',
      tokens: {
        provider: 'anthropic',
        tokensIn: 120,
        tokensOut: 42,
        tokensCacheRead: 3000,
        tokensCacheWrite: 40,
      },
    });
  });

  it("is read from a whole answer, Anthropic's or OpenAI's, the cached input apart", async () => {
    expect(
      await through('anthropic', false, [
        '{"model":"claude-haiku-4-5","usage":{"input_tokens":5,"output_tokens":7}}',
      ]),
    ).toMatchObject({ model: 'claude-haiku-4-5', tokens: { tokensIn: 5, tokensOut: 7 } });
    expect(
      await through('openai', true, [
        'event: response.created\ndata: {"type":"response.created"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5","usage":{"input_tokens":1000,"output_tokens":200,"input_tokens_details":{"cached_tokens":600}}}}\n\n',
      ]),
    ).toEqual({
      model: 'gpt-5',
      tokens: {
        provider: 'openai',
        tokensIn: 400,
        tokensOut: 200,
        tokensCacheRead: 600,
        tokensCacheWrite: 0,
      },
    });
  });

  it('counts nothing for an answer that says nothing of usage', async () => {
    expect(
      await through('anthropic', false, ['{"error":{"message":"overloaded"}}']),
    ).toBeUndefined();
  });
});
