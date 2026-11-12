import { lazy, memo, Suspense } from 'react';

/** Markdown as it was written: until the renderer loads, or if it cannot. */
const Plain = ({ children, className }: { children: string; className?: string }) => (
  <p className={`markdown whitespace-pre-wrap ${className ?? ''}`}>{children}</p>
);
// The markdown renderer is a fifth of the app's code: it loads with the first text of a task. A
// tab opened before a deploy may ask for a chunk that is gone; the text then shows as it is.
const Markdown = lazy(() =>
  import('../ui/markdown').then(
    ({ Markdown }) => ({ default: Markdown }),
    () => ({ default: Plain }),
  ),
);

/**
 * A task's text, a comment or a run's report, in markdown. The page asks for the task every few
 * seconds; the text is parsed again only when it changes.
 */
export const Prose = memo(function Prose(props: { children: string; className?: string }) {
  return (
    <Suspense fallback={<Plain className={props.className}>{props.children}</Plain>}>
      <Markdown className={props.className}>{props.children}</Markdown>
    </Suspense>
  );
});
