import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

// shadcn/ui dialog, restyled. The product's only confirmation: never window.confirm or alert.
// No corner close button: every dialog names its way out in the footer, and Escape works. A
// composer (New task, New token) is the exception: a close button in its corner, and a sheet of
// its own on a phone.
// Taller than the screen, as a form is on a phone with its keyboard up, it scrolls inside.
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

/**
 * Two widths, not one per dialog: 520 px for a form or a question, 760 px for what has to be
 * read whole (a workspace preview, a command to paste on one line). A composer is 660.
 */
function DialogContent({
  className,
  size = 'form',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { size?: 'form' | 'wide' }) {
  return (
    <DialogPrimitive.Portal>
      {/* The scrim is the desk surface itself: the page recedes in both themes. */}
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-desk/80" />
      <DialogPrimitive.Content
        className={cn(
          size === 'wide' ? 'max-w-190' : 'max-w-130',
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] grid-cols-[minmax(0,1fr)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border border-line-strong bg-raised p-6 text-ink shadow-overlay outline-none data-[state=open]:animate-overlay-in max-md:p-5',
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}

/**
 * A composer's content, with size="wide": its top stays put as it grows. On a phone, a sheet from
 * the top edge, as tall as what is in it, so its fields and its button stay above the keyboard.
 */
const composer =
  'top-[12dvh] max-h-[calc(88dvh-16px)] max-w-165 translate-y-0 gap-0 p-0 max-md:top-0 max-md:left-0 max-md:max-h-dvh max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:rounded-t-none max-md:border-x-0 max-md:border-t-0 max-md:p-0 max-md:pt-[env(safe-area-inset-top)]';

function DialogTitle(props: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className="text-section" {...props} />;
}

function DialogDescription(props: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className="text-ink-2" {...props} />;
}

function DialogFooter(props: ComponentProps<'div'>) {
  return <div className="flex justify-end gap-2 pt-2" {...props} />;
}

export {
  composer,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
};
