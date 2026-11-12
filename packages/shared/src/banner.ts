// The name in large letters when the server or the worker starts, in the block letters
// many CLIs open with: the letters in full blocks, their shadow in box-drawing lines.
const NAME = [
  ' █████╗  ██████╗ ███████╗███╗   ██╗████████╗ ██████╗ ███╗   ███╗███████╗',
  '██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔═══██╗████╗ ████║██╔════╝',
  '███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║   ██║██╔████╔██║█████╗',
  '██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║   ██║██║╚██╔╝██║██╔══╝',
  '██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ╚██████╔╝██║ ╚═╝ ██║███████╗',
  '╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝╚══════╝',
];
const WIDTH = Math.max(...NAME.map((line) => line.length));

/**
 * The banner: a framed line saying what started, then the name. With `color` (a terminal, not a
 * log file) the letters are bold and their shadow grey.
 */
export function banner(line: string, color = false): string {
  const inner = WIDTH - 2;
  const text = ` ✻ ${line}`.slice(0, inner).padEnd(inner);
  const grey = (s: string) => (color ? `\x1b[90m${s}\x1b[0m` : s);
  const name = NAME.map((row) =>
    color
      ? row
          .replace(/[^█\s]+/g, (shadow) => grey(shadow))
          .replace(/█+/g, (b) => `\x1b[1m${b}\x1b[0m`)
      : row,
  );
  return [
    grey(`╭${'─'.repeat(inner)}╮`),
    `${grey('│')}${text}${grey('│')}`,
    grey(`╰${'─'.repeat(inner)}╯`),
    ...name,
    '',
  ].join('\n');
}
