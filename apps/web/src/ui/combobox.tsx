import { Check, ChevronDown, Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { buttonVariants } from './button';
import { fieldChip } from './chip';
import { cn } from './cn';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { triggerVariants } from './select';

// The shadcn combobox recipe (Popover + Command): a select whose options can be searched.
type Option = { value: string; label: string };

function Combobox({
  id,
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  trigger = 'select',
  face,
}: {
  id?: string;
  /**
   * `action`: a small secondary button that adds what is picked, not a field that holds it.
   * `icon`: the same as a quiet + beside a list's heading, named by the placeholder.
   * `chip`: a field as Linear shows it under a title, showing `face`, named by the placeholder.
   */
  trigger?: 'select' | 'action' | 'icon' | 'chip';
  /** What a `chip` shows: the value with its icon. */
  face?: ReactNode;
  options: Option[];
  value: string | null;
  onValueChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {trigger === 'chip' ? (
        <PopoverTrigger id={id} role="combobox" aria-label={placeholder} className={fieldChip}>
          {face}
        </PopoverTrigger>
      ) : trigger === 'icon' ? (
        <PopoverTrigger
          id={id}
          role="combobox"
          aria-label={placeholder}
          className={cn(buttonVariants({ variant: 'quiet', size: 'icon-sm' }))}
        >
          <Plus aria-hidden="true" className="size-4" />
        </PopoverTrigger>
      ) : trigger === 'action' ? (
        <PopoverTrigger id={id} role="combobox" className={cn(buttonVariants({ size: 'sm' }))}>
          <Plus aria-hidden="true" className="size-3.5" />
          {placeholder}
        </PopoverTrigger>
      ) : (
        <PopoverTrigger id={id} role="combobox" className={triggerVariants()}>
          <span className={cn('min-w-0 truncate', !selected && 'text-ink-3')}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown className="size-4 shrink-0 text-ink-2 transition-transform duration-120 group-aria-expanded:rotate-180" />
        </PopoverTrigger>
      )}
      {/* As wide as its field, and never narrower than a name with a role: an Add button is short. */}
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => {
                    onValueChange(option.value);
                    setOpen(false);
                  }}
                >
                  {/* One line per option: the rows are 32 px, so a long label is cut, not wrapped. */}
                  <span className="min-w-0 truncate" title={option.label}>
                    {option.label}
                  </span>
                  <Check
                    className={cn('ml-auto size-3.5', option.value !== value && 'invisible')}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export { Combobox };
