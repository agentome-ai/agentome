import { useId, useState } from 'react';
import { api, asApiError } from '../api';
import { Button } from '../ui/button';
import { FormError } from '../ui/field';
import { Textarea } from '../ui/input';
import type { Approval } from './approvals-data';

/** What an agent asked with ask_owner: the question and the answers it offered. */
export function questionOf(call: Pick<Approval, 'input'>) {
  const input = (call.input ?? {}) as { question?: unknown; options?: unknown };
  return {
    question: typeof input.question === 'string' ? input.question : '',
    options: Array.isArray(input.options)
      ? input.options.filter((option): option is string => typeof option === 'string')
      : [],
  };
}

/**
 * The answer to an agent's question: an offered answer fills the field, Send answer hands it
 * to the waiting agent, and Skip tells it nobody will answer.
 */
export function AnswerForm(props: { call: Approval; onDone: () => Promise<void> | void }) {
  const { call } = props;
  const ids = useId();
  const { question, options } = questionOf(call);
  const [answer, setAnswer] = useState('');
  const [pending, setPending] = useState<'answer' | 'skip'>();
  const [error, setError] = useState<string>();

  async function send(kind: 'answer' | 'skip') {
    if (pending) return;
    setPending(kind);
    setError(undefined);
    try {
      if (kind === 'answer') {
        await api(`/api/tool-calls/${call.id}/answer`, { body: { answer: answer.trim() } });
      } else await api(`/api/tool-calls/${call.id}/deny`, { body: {} });
      await props.onDone();
    } catch (caught) {
      setError(asApiError(caught).message);
      setPending(undefined);
    }
  }

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send('answer');
      }}
    >
      <p id={`${ids}-question`} className="break-words whitespace-pre-wrap">
        {question}
      </p>
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Offered answers">
          {options.map((option) => (
            // An offered answer may be a sentence: it wraps instead of running off a phone.
            <Button
              key={option}
              type="button"
              size="sm"
              aria-pressed={answer === option}
              onClick={() => setAnswer(option)}
              className="h-auto min-h-7 max-w-full shrink py-1 text-left whitespace-normal"
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <Textarea
        aria-label="Your answer"
        aria-describedby={`${ids}-question`}
        rows={3}
        maxLength={4000}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
      />
      {error && <FormError>{error}</FormError>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="quiet"
          disabled={!!pending}
          onClick={() => void send('skip')}
        >
          Skip
        </Button>
        <Button type="submit" variant="decision" disabled={!!pending || !answer.trim()}>
          {pending === 'answer' ? 'Sending…' : 'Send answer'}
        </Button>
      </div>
    </form>
  );
}
