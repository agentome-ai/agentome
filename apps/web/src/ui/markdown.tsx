import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from './cn';

// Agents write much of what this shows (a run's messages and report, later memory), so it is
// read as untrusted. HTML stays text (no rehype-raw). Links go to http(s) and mailto, opening
// apart from the page, or to a place on it (#, as footnotes do); a path would land in the app
// wherever the agent pointed, so it stays text. No image is fetched: its address could carry
// what an agent read to another server the moment the page shows it; its alt text shows.
// http(s) with a host: "https:/api/x" or "http:x" would resolve inside the app, like a path.
const safeUrl = (url: string) => (/^(https?:\/\/|mailto:|#)/i.test(url) ? url : '');

/**
 * To an element of the page, scrolled to and focused in place, instead of the browser's own
 * jump to `#id`: that leaves a history entry the router cannot hold, and Back from a later page
 * with unsaved edits would no longer ask before leaving them. A target the page does not have
 * (a footnote cut off with the text) is left to the browser, which goes nowhere.
 */
export function jumpTo(event: { preventDefault(): void }, id: string): void {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
  target.scrollIntoView();
  target.focus({ preventScroll: true });
}

const components: Components = {
  a: ({ href, children, ...rest }) => {
    // react-markdown passes its syntax node along with the attributes (a footnote's id).
    delete rest.node;
    if (!href) return <span>{children}</span>;
    if (href.startsWith('#')) {
      // An agent may write `#100%`: a fragment that does not decode names nothing on the page.
      const id = (() => {
        try {
          return decodeURIComponent(href.slice(1));
        } catch {
          return '';
        }
      })();
      return (
        <a {...rest} href={href} onClick={(event) => jumpTo(event, id)}>
          {children}
        </a>
      );
    }
    return (
      <a {...rest} target="_blank" rel="noreferrer" href={href}>
        {children}
      </a>
    );
  },
  img: ({ alt }) => <span className="text-ink-3">[{alt || 'image'}]</span>,
  // Code and tables wider than their column scroll inside themselves, never the page or the
  // margin; focusable, so that a keyboard scrolls them where the browser does not (Safari).
  pre: ({ children, ...rest }) => {
    delete rest.node;
    return (
      <pre {...rest} tabIndex={0}>
        {children}
      </pre>
    );
  },
  table: ({ children, ...rest }) => {
    delete rest.node;
    return (
      <div className="overflow-x-auto" tabIndex={0}>
        <table {...rest}>{children}</table>
      </div>
    );
  },
};

/**
 * Markdown as people read it in the product: an agent's instructions, a run's transcript and
 * report, later tasks and memory. GitHub-flavored; the typography is `.markdown` in index.css.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('markdown', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
