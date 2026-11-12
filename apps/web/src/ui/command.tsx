import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useRef, type ComponentProps } from 'react';
import { DialogContent } from './dialog';

// shadcn/ui command (cmdk), restyled. Used by the ⌘K palette and by Combobox.
function Command(props: ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive className="flex flex-col text-ink" {...props} />;
}

function CommandDialog({
  title,
  description,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Root> & { title: string; description: string }) {
  // Opened by a shortcut, not by a trigger: give focus back to where it was on close.
  const returnTo = useRef<Element | null>(null);
  return (
    <DialogPrimitive.Root {...props}>
      <DialogContent
        className="top-[20vh] max-w-160 translate-y-0 gap-0 overflow-hidden p-0"
        onOpenAutoFocus={() => (returnTo.current = document.activeElement)}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnTo.current instanceof HTMLElement) returnTo.current.focus();
        }}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
        <Command>{children}</Command>
      </DialogContent>
    </DialogPrimitive.Root>
  );
}

function CommandInput(props: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex h-11 items-center gap-2.5 border-b border-line px-3.5">
      <Search className="shrink-0 text-ink-3" aria-hidden />
      <CommandPrimitive.Input
        className="h-full w-full bg-transparent text-read outline-none placeholder:text-ink-3"
        {...props}
      />
    </div>
  );
}

function CommandList(props: ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className="max-h-90 scroll-py-1 overflow-y-auto p-1" {...props} />;
}

function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="px-2 py-6 text-center text-ink-2" {...props} />;
}

function CommandGroup(props: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-small [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3"
      {...props}
    />
  );
}

function CommandItem(props: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 outline-none select-none data-[disabled=true]:opacity-45 data-[selected=true]:bg-hover [&_svg]:shrink-0 [&_svg]:text-ink-2"
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
};
