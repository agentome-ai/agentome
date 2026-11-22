import { diffLines } from 'diff';
import { cn } from './cn';

/** A line diff: removed lines struck on the failed tint, added ones on the running tint. */
export function Changes({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre
      aria-label="Changes"
      className="max-h-[50dvh] overflow-auto rounded-md bg-desk p-3 font-mono text-ui leading-5 whitespace-pre-wrap"
    >
      {parts.map((part, i) =>
        part.value
          .replace(/\n$/, '')
          .split('\n')
          .map((line, j) => (
            <span
              key={`${i}-${j}`}
              className={cn(
                'block',
                part.added && 'bg-running/12 text-ink',
                part.removed && 'bg-failed/12 text-ink-2 line-through',
                !part.added && !part.removed && 'text-ink-3',
              )}
            >
              {part.added ? '+ ' : part.removed ? '− ' : '  '}
              {line}
            </span>
          )),
      )}
    </pre>
  );
}
