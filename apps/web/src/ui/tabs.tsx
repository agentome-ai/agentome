import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

// shadcn/ui tabs, restyled as the segmented control of the plan: it switches the view of one
// thing (Write and Preview of the instructions, Today and 7 days on the dashboard).
const Tabs = TabsPrimitive.Root;
const TabsContent = TabsPrimitive.Content;

function TabsList(props: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className="flex w-fit gap-0.5 rounded-lg border border-line bg-desk p-0.5"
      {...props}
    />
  );
}

function TabsTrigger(props: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className="h-6 rounded-md px-2.5 font-medium whitespace-nowrap text-ink-2 hover:text-ink data-[state=active]:bg-raised data-[state=active]:text-ink data-[state=active]:ring-1 data-[state=active]:ring-line-strong"
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
