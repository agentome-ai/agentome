import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { AgentTile } from '../ui/tint';

/**
 * Tasks' and Runs' agent filter: a chip with the agents' tiles, so it reads as whose work
 * this is rather than as one more grey field. On a phone "All agents" is "All", to sit on one
 * line with the status tabs.
 */
export function AgentFilter({
  value,
  onChange,
  options,
}: {
  /** An agent's id, or 'all'. */
  value: string;
  onChange: (value: string) => void;
  options: { id: string; name: string }[];
}) {
  const faces = options.slice(0, 3);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label="Agent"
        className="h-8 w-auto max-w-60 rounded-full border-line-strong bg-paper pl-1.5"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">
          <span className="flex items-center gap-2">
            {faces.length > 0 && (
              <span aria-hidden="true" className="flex">
                {faces.map((agent) => (
                  // Each tile on the page's colour, so the one over it does not show through.
                  <span
                    key={agent.id}
                    className="-ml-1 rounded-md bg-paper ring-2 ring-paper first:ml-0"
                  >
                    <AgentTile id={agent.id} name={agent.name} />
                  </span>
                ))}
              </span>
            )}
            <span>
              All<span className="max-md:hidden"> agents</span>
            </span>
          </span>
        </SelectItem>
        {options.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            <span className="flex items-center gap-2">
              <AgentTile id={agent.id} name={agent.name} />
              {agent.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
