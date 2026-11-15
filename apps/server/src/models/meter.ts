import { Transform } from 'node:stream';
import type { RelayTokens } from '@agentome/db';

// What a provider says a call used, read from its answer as the relay passes it on: Anthropic's
// messages (a JSON body, or the `message_start` and `message_delta` events of a stream) and
// OpenAI's responses (a JSON body, or the `response.completed` event). Counted as the seat
// counts them: OpenAI's cached input apart from the rest.

export type Metered = { model: string; tokens: RelayTokens };

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};
type OpenAiUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
};

const n = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0);

/** One answer's tokens, from the JSON of a whole answer or of one stream event. */
export class Meter {
  model = '';
  readonly tokens: RelayTokens;

  constructor(provider: RelayTokens['provider']) {
    this.tokens = { provider, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
  }

  /** Reads one JSON value of the answer: the whole body, or one event's data. */
  read(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const data = value as Record<string, unknown>;
    if (this.tokens.provider === 'anthropic') {
      // A whole message, or a stream's start, carries the input; a delta, the output so far.
      const message = (data.type === 'message_start' ? data.message : data) as
        { model?: unknown; usage?: AnthropicUsage } | undefined;
      if (typeof message?.model === 'string') this.model = message.model;
      const usage = (data.type === 'message_delta' ? data.usage : message?.usage) as
        AnthropicUsage | undefined;
      if (!usage) return;
      if (data.type !== 'message_delta') {
        this.tokens.tokensIn = n(usage.input_tokens);
        this.tokens.tokensCacheRead = n(usage.cache_read_input_tokens);
        this.tokens.tokensCacheWrite = n(usage.cache_creation_input_tokens);
      }
      // The output so far: the last one counts.
      if (usage.output_tokens !== undefined) this.tokens.tokensOut = n(usage.output_tokens);
      return;
    }
    const response = (data.type === 'response.completed' ? data.response : data) as
      { model?: unknown; usage?: OpenAiUsage } | undefined;
    if (typeof response?.model === 'string') this.model = response.model;
    const usage = response?.usage;
    if (!usage) return;
    const cached = n(usage.input_tokens_details?.cached_tokens);
    this.tokens.tokensIn = Math.max(0, n(usage.input_tokens) - cached);
    this.tokens.tokensOut = n(usage.output_tokens);
    this.tokens.tokensCacheRead = cached;
  }

  /** What was counted, once the answer is over; nothing for an answer that named no model. */
  done(asked: string | undefined): Metered | undefined {
    const model = this.model || asked;
    const t = this.tokens;
    if (!model || t.tokensIn + t.tokensOut + t.tokensCacheRead + t.tokensCacheWrite === 0) {
      return undefined;
    }
    return { model, tokens: { ...t } };
  }
}

/**
 * Passes an answer on as it is and reads its usage as it goes: a stream's `data:` lines, or the
 * whole body as JSON at its end. `onEnd` gets what was counted.
 */
export function metering(meter: Meter, stream: boolean, onEnd: () => void): Transform {
  let buffered = '';
  const MAX_BODY = 32 * 1024 * 1024;
  const readLines = (text: string) => {
    for (const line of text.split('\n')) {
      const data = /^data:\s?(.*)$/.exec(line.trim())?.[1];
      if (!data || data === '[DONE]') continue;
      try {
        meter.read(JSON.parse(data));
      } catch {
        // Not JSON: nothing of usage in it.
      }
    }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (stream) {
        buffered += chunk.toString('utf8');
        const end = buffered.lastIndexOf('\n');
        if (end >= 0) {
          readLines(buffered.slice(0, end));
          buffered = buffered.slice(end + 1);
        }
      } else if (buffered.length < MAX_BODY) {
        buffered += chunk.toString('utf8');
      }
      done(null, chunk);
    },
    flush(done) {
      if (stream) readLines(buffered);
      else {
        try {
          meter.read(JSON.parse(buffered));
        } catch {
          // Not JSON: an error page, say.
        }
      }
      onEnd();
      done();
    },
  });
}
