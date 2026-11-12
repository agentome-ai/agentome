// What a call sends, as it will be sent: every argument whole and literal, in monospace, next to
// every Approve. A summary or rendered Markdown can hide a link: `![status](https://…/?d=…)` reads
// as nothing, yet the code host loads it for everyone who opens the change. So the addresses in
// it are listed apart, too.

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/** Every web address in the strings of a call's input, once each, in order. */
export function addressesIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    for (const match of value.matchAll(URL_PATTERN)) {
      if (!found.includes(match[0])) found.push(match[0]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) addressesIn(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) addressesIn(item, found);
  }
  return found;
}

const literal = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

export function CallArguments(props: { tool: string; input: unknown; compact?: boolean }) {
  const { input } = props;
  const entries: [string, unknown][] =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.entries(input)
      : input === undefined || input === null
        ? []
        : [['input', input]];
  const addresses = addressesIn(input);
  return (
    <div className="grid gap-2">
      <dl
        aria-label="What it sends"
        className="overflow-hidden rounded-lg border border-line text-left"
      >
        {[['Tool', props.tool] as [string, unknown], ...entries].map(([key, value]) => (
          <div
            key={key}
            className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-3 border-line px-3 py-2 not-first:border-t max-sm:grid-cols-1 max-sm:gap-1"
          >
            <dt className="truncate text-ink-3">{key}</dt>
            <dd
              tabIndex={0}
              className={`${props.compact ? 'max-h-32' : 'max-h-80'} overflow-auto font-mono text-[12.5px] [overflow-wrap:anywhere] whitespace-pre-wrap`}
            >
              {literal(value)}
            </dd>
          </div>
        ))}
      </dl>
      {addresses.length > 0 && (
        <div className="rounded-lg border border-line px-3 py-2">
          <p className="text-small text-ink-2">
            Addresses in it: whoever opens what it posts may load them
          </p>
          <ul aria-label="Addresses in it" className="mt-1 grid gap-0.5">
            {addresses.map((address) => (
              <li key={address} className="font-mono text-[12.5px] [overflow-wrap:anywhere]">
                {address}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
