import { Pencil } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cn } from './cn';
import { Textarea } from './input';

/** Saves the text; answers why it could not, or nothing once it did. */
export type Save = (text: string) => Promise<string | undefined>;

/**
 * Text changed where it is read, as Linear's issue is: a click on it, or its Edit
 * button from the keyboard, turns it into its field, which saves when focus leaves it. Escape
 * puts the text back. A click on a link in it, or one that ends a selection, only does that.
 */
export function InPlace(props: {
  /** The field's name, and its button's: "Edit title". */
  label: string;
  text: string;
  /** What reads in place of the text. */
  children: ReactNode;
  onSave: Save;
  /** A title is one line: Enter saves it. A description takes Enter as a new line. */
  oneLine?: boolean;
  fieldClassName?: string;
  /** A title's field: larger than a phone's 16 px floor, so it keeps its own size. */
  heading?: boolean;
  /** A line under the field: what the change does. */
  note?: ReactNode;
}) {
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Escape and a save that ended both leave the field; its blur must not save again.
  const leaving = useRef(false);
  const editing = draft !== undefined;

  // The field grows with its text, so it reads as the text it replaced, and opens with the
  // caret after the last word.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [draft]);
  const opened = useRef(false);
  useLayoutEffect(() => {
    const element = field.current;
    if (!editing) {
      opened.current = false;
      return;
    }
    if (!element || opened.current) return;
    opened.current = true;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editing]);

  function open() {
    leaving.current = false;
    setError(undefined);
    setDraft(props.text);
  }

  function close(refocus: boolean) {
    leaving.current = true;
    setDraft(undefined);
    setError(undefined);
    // Back on the button only when the keyboard left the field (a click went somewhere else),
    // and only if nothing has taken focus since: the next field may already be open.
    if (!refocus) return;
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) button.current?.focus();
    });
  }

  async function save(refocus: boolean) {
    if (draft === undefined || leaving.current || saving) return;
    const text = props.oneLine ? draft.trim() : draft;
    if (text === props.text) return close(refocus);
    setSaving(true);
    const failed = await props.onSave(text);
    setSaving(false);
    if (failed) {
      setError(failed);
      field.current?.focus();
    } else close(refocus);
  }

  if (editing) {
    const ids = `in-place-${props.label.replace(/\W+/g, '-').toLowerCase()}`;
    return (
      <div>
        <Textarea
          ref={field}
          aria-label={props.label}
          data-heading={props.heading || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={cn(error && `${ids}-error`, props.note && `${ids}-note`) || undefined}
          value={draft}
          readOnly={saving}
          rows={1}
          className={cn('-mx-2 w-[calc(100%+1rem)] resize-none px-2', props.fieldClassName)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close(true);
            } else if (
              event.key === 'Enter' &&
              (props.oneLine || event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void save(true);
            }
          }}
        />
        {error && (
          <p id={`${ids}-error`} role="alert" className="mt-1.5 text-small text-failed">
            {error}
          </p>
        )}
        {props.note && !error && (
          <p id={`${ids}-note`} className="mt-1.5 text-small text-ink-3">
            {props.note}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="group relative -mx-2 cursor-text rounded-md px-2 transition-colors duration-120 hover:bg-hover"
      onClick={(event) => {
        if ((event.target as Element).closest('a, button')) return;
        if (window.getSelection()?.isCollapsed === false) return;
        open();
      }}
    >
      {props.children}
      <button
        ref={button}
        type="button"
        aria-label={`Edit ${props.label.toLowerCase()}`}
        className="absolute top-1 right-1 inline-flex size-7 items-center justify-center rounded-md bg-raised text-ink-2 opacity-0 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100 max-md:hidden"
        onClick={open}
      >
        <Pencil aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
