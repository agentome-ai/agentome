import { setTimeout as sleep } from 'node:timers/promises';

// The mark on its plate, as install.sh draws it: one character a pixel, a to x the 24 greys of the
// terminal's 256-colour ramp, dark to light, a dot no pixel. Two rows of pixels make one line,
// drawn with ▀ in the top pixel's colour on the bottom one's.
const MARK = `
...bbbbbbbbbbbbbbbbbb...
.bbbbbbbbbbbbbbbbbbbbbb.
.bbbbbbbbbbbbbbbbbbbbbb.
bbbbbbbbbbbbbbbbbbbbbbbb
bbbbbbbbbbbbbbbbbbbbbbbb
bbbbbbbbbbempmdbbbbbbbbb
bbbbbbbbbixxxxxgbbbbbbbb
bbbbbbbbfxxxxxxvcbbbbbbb
bbbbbbbcvxxxxxxxobbbbbbb
bbbbbbbrxsquxxxxxfbbbbbb
bbbbbbmwnljhnxxxwrbbbbbb
bbbbbhwrpnljgqwwwvibbbbb
bbbbdvvtrpnjbduvvuscbbbb
bbbbtxxvtrncbbjuuutlbbbb
bbbnxxxxvsebbbbqttssebbb
bbbxxxxxxgbbbbbesssrmbbb
bbbxxxxxlbbbbbbbkrrrnbbb
bbbnxxxpbbbbbbbbcoqqhbbb
bbbbjqlbbbbbbbbbbcjhbbbb
bbbbbbbbbbbbbbbbbbbbbbbb
bbbbbbbbbbbbbbbbbbbbbbbb
.bbbbbbbbbbbbbbbbbbbbbb.
.bbbbbbbbbbbbbbbbbbbbbb.
...bbbbbbbbbbbbbbbbbb...
`;

const GREYS = 'abcdefghijklmnopqrstuvwx';
const RESET = '\u001b[0m';

/** The mark's lines, coloured for a terminal of 256 colours. */
export function markLines(): string[] {
  const rows = MARK.split('\n').filter((row) => row !== '');
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y] ?? '';
    const low = rows[y + 1] ?? '';
    let line = '  ';
    for (let x = 0; x < top.length; x++) {
      const t = GREYS.indexOf(top[x] ?? '.') + 1;
      const b = GREYS.indexOf(low[x] ?? '.') + 1;
      if (!t && !b) line += `${RESET} `;
      else if (!b) line += `${RESET}\u001b[38;5;${231 + t}m▀`;
      else if (!t) line += `${RESET}\u001b[38;5;${231 + b}m▄`;
      else line += `\u001b[38;5;${231 + t};48;5;${231 + b}m▀`;
    }
    lines.push(`${line}${RESET}`);
  }
  return lines;
}

/** Whether the output is a person's terminal with colours, not a log, CI or NO_COLOR. */
export function colours(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): boolean {
  return stream.isTTY === true && !env.NO_COLOR && !env.CI && (env.TERM ?? 'dumb') !== 'dumb';
}

/**
 * Opens with the mark, the name typed beside it and what is about to happen; one plain line where
 * there are no colours.
 */
export async function banner(what: string, out: NodeJS.WriteStream = process.stdout) {
  if (!colours(out)) {
    out.write(`Agentome: ${what}\n`);
    return;
  }
  out.write('\n');
  const lines = markLines();
  for (const [row, line] of lines.entries()) {
    out.write(`${line}   `);
    if (row === 4) {
      out.write('\u001b[1m');
      for (const letter of 'agentome') {
        out.write(letter);
        await sleep(40);
      }
      out.write(RESET);
    } else if (row === 5) out.write(`\u001b[2mAI employees, on your own servers${RESET}`);
    else if (row === 7) out.write(what);
    out.write('\n');
    await sleep(30);
  }
  out.write('\n');
}
