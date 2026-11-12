import type { ComponentProps } from 'react';
import { cn } from './cn';

// shadcn/ui table, restyled: 36 px rows on hairlines, one line per cell. No sideways scroll
// wrapper: a narrow table drops columns by priority instead, hiding the <col> and its cells
// together (max-xl:hidden on both), or the cells after it would slide into the wrong column.
// With `phoneList`, a phone reads it as an app's list: no header, each row a 60 px item
// with its `primary` cell on the first line, the cells left on a quiet second, a chevron after.
function Table({
  className,
  phoneList = false,
  ...props
}: ComponentProps<'table'> & { phoneList?: boolean }) {
  return (
    <table
      className={cn('w-full border-collapse', phoneList && 'phone-list', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('border-b border-line', className)} {...props} />;
}

function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'h-8 truncate px-3 text-left text-small font-medium whitespace-nowrap text-ink-2',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({
  className,
  primary = false,
  ...props
}: ComponentProps<'td'> & { primary?: boolean }) {
  return (
    <td
      data-primary={primary || undefined}
      className={cn('h-9 truncate px-3 whitespace-nowrap', className)}
      {...props}
    />
  );
}

export { Table, TableCell, TableHead, TableRow };
