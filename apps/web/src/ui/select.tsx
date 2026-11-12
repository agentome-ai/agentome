import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronDown } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { fieldChip } from './chip';
import { cn } from './cn';

// shadcn/ui select on Radix, restyled. Never a native <select>: its OS popup ignores the theme.
// The trigger styles are shared with Combobox so both read as the same control.
const triggerVariants = cva(
  'group flex w-full items-center justify-between gap-2 rounded-md border pr-2 pl-2.5 text-left text-ink disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-failed data-[placeholder]:text-ink-3 [&>span]:truncate',
  {
    variants: {
      variant: {
        default: 'border-line-control bg-raised hover:bg-hover',
        // Dense tables: no border until hover or open, the chevron alone marks the control.
        quiet:
          '-ml-2 border-transparent pl-2 hover:border-line-control hover:bg-raised aria-expanded:border-line-control aria-expanded:bg-raised',
      },
      size: { default: 'h-8', sm: 'h-7' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

const overlayPanel =
  'z-50 overflow-y-auto rounded-xl border border-line-strong bg-raised p-1 text-ui text-ink shadow-overlay data-[state=open]:animate-overlay-in';

const menuItem =
  'relative flex min-h-[30px] cursor-default items-center gap-2 rounded-md px-2 py-[5px] outline-none select-none data-[disabled]:opacity-45 data-[highlighted]:bg-hover';

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({
  className,
  variant,
  size,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & VariantProps<typeof triggerVariants>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(triggerVariants({ variant, size }), className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-ink-2 transition-transform duration-120 group-aria-expanded:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** A select shown as a field chip under a title: it shows its children, no chevron. */
function SelectChip({ className, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger className={cn(fieldChip, className)} {...props} />;
}

function SelectContent({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        className={cn(
          overlayPanel,
          'max-h-(--radix-select-content-available-height) max-w-80 min-w-(--radix-select-trigger-width)',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  description,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item> & { description?: ReactNode }) {
  return (
    <SelectPrimitive.Item className={cn(menuItem, 'justify-between gap-4', className)} {...props}>
      <span className="grid gap-px">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {description && <span className="text-small text-ink-3">{description}</span>}
      </span>
      <SelectPrimitive.ItemIndicator>
        <Check className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

/** A labelled run of items, such as Teams and Agents in one list. */
function SelectGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SelectPrimitive.Group>
      <SelectPrimitive.Label className="px-2 pt-2 pb-1 text-small text-ink-3">
        {label}
      </SelectPrimitive.Label>
      {children}
    </SelectPrimitive.Group>
  );
}

export {
  menuItem,
  overlayPanel,
  Select,
  SelectChip,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  triggerVariants,
};
