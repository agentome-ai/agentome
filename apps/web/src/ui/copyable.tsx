import { useRef, useState } from 'react';
import { Button } from './button';

/**
 * A literal a person has to move somewhere else by hand: a command for a terminal, a webhook
 * address, a secret for a host's settings. Without clipboard access (a server on plain http)
 * the text is selected instead, so ⌘C still works.
 */
export function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const text = useRef<HTMLElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      if (text.current) window.getSelection()?.selectAllChildren(text.current);
    }
  }

  return (
    // All of it in view, the button beside it: a long command wraps between its words, never
    // inside one (the pairing code at its end is the part people check), and a single word too
    // long for the box, such as a secret, breaks where it must.
    <div className="flex min-w-0 items-center gap-3 rounded-lg bg-desk py-2 pr-2 pl-3">
      <code ref={text} className="min-w-0 flex-1 font-mono text-small break-words">
        {value}
      </code>
      <Button size="sm" className="shrink-0" onClick={() => void copy()}>
        {copied ? 'Copied' : label}
      </Button>
    </div>
  );
}
