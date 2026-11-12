import { createHash } from 'node:crypto';

// The few pieces of git's wire format the proxy reads and writes: the commands at the
// head of a push, a report-status answer, and an empty pack. Everything else passes through as
// bytes. gitprotocol-pack(5), gitprotocol-common(5).

export const FLUSH = Buffer.from('0000');

export interface PushCommand {
  readonly old: string;
  readonly new: string;
  readonly ref: string;
}

export interface PushHead {
  readonly commands: PushCommand[];
  /** The capabilities the push asks for, by name: `object-format=sha256` is `object-format`. */
  readonly capabilities: string[];
  /** Where the commands end, flush included: what follows is the pack, passed on as it is. */
  readonly end: number;
}

const COMMAND = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/;

/**
 * The commands of a push, once `head` holds all of them; `incomplete` while more bytes are to
 * come; a sentence when the head is not a push the proxy can read. `shallow` lines are skipped;
 * a signed push (`push-cert`) is not read, so it is refused.
 */
export function parsePushHead(head: Buffer): PushHead | 'incomplete' | string {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (let at = 0; ;) {
    if (head.length < at + 4) return 'incomplete';
    const size = Number.parseInt(head.toString('latin1', at, at + 4), 16);
    if (!/^[0-9a-f]{4}$/i.test(head.toString('latin1', at, at + 4)) || (size > 0 && size < 5)) {
      return 'This is not a git push';
    }
    if (size === 0) {
      return commands.length ? { commands, capabilities, end: at + 4 } : 'This push names no ref';
    }
    if (head.length < at + size) return 'incomplete';
    let line = head.toString('utf8', at + 4, at + size).replace(/\n$/, '');
    at += size;
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        // As git reads them: a capability ends at any whitespace or at `=`, so `push-options=1`
        // and a tab before the word ask the host for the same as ` push-options`.
        capabilities = line
          .slice(nul + 1)
          .split(/\s+/)
          .filter(Boolean)
          .map((capability) => capability.split('=', 1)[0] ?? '');
        line = line.slice(0, nul);
      }
    }
    if (line.startsWith('shallow ')) continue;
    if (line.startsWith('push-cert')) return 'Agentome does not pass signed pushes on';
    const match = COMMAND.exec(line);
    if (!match) return 'This is not a git push';
    commands.push({ old: match[1] ?? '', new: match[2] ?? '', ref: match[3] ?? '' });
  }
}

export const isZero = (sha: string) => /^0+$/.test(sha);

export function pkt(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data) : data;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}

/**
 * A report-status answer: `unpack ok`, then `ok <ref>` or `ng <ref> <why>` per command, which
 * git prints as `! [remote rejected] … (why)`. In band 1 when the client asked for side-band.
 */
export function reportStatus(results: { ref: string; refusal?: string }[], capabilities: string[]) {
  const lines = [
    'unpack ok',
    ...results.map((r) => (r.refusal ? `ng ${r.ref} ${r.refusal}` : `ok ${r.ref}`)),
  ];
  const report = Buffer.concat([...lines.map((line) => pkt(`${line}\n`)), FLUSH]);
  const band = capabilities.includes('side-band-64k')
    ? 65515
    : capabilities.includes('side-band')
      ? 995
      : 0;
  if (band === 0) return report;
  const packets: Buffer[] = [];
  for (let at = 0; at < report.length; at += band) {
    packets.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(at, at + band)])));
  }
  return Buffer.concat([...packets, FLUSH]);
}

/**
 * The refs a host's report-status answer says it did not update (`ng <ref> <why>`), read from
 * band 1 when the client asked for side-band; undefined when the answer is not one the proxy
 * can read. An answer with no report in it refuses none: a push need not ask for a report, and
 * the host updates its refs all the same.
 */
export function refusedRefs(answer: Buffer, capabilities: string[]): Set<string> | undefined {
  const sideband = capabilities.includes('side-band-64k') || capabilities.includes('side-band');
  const outer = payloads(answer);
  const report =
    sideband && outer
      ? payloads(Buffer.concat(outer.filter((p) => p[0] === 1).map((p) => p.subarray(1))))
      : outer;
  if (!report) return undefined;
  const refs = new Set<string>();
  for (const line of report) {
    const text = line.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('ng ')) refs.add(text.slice(3).split(' ', 1)[0] ?? '');
  }
  return refs;
}

/** What a run of pkt-lines carries, flush and delimiters left out; undefined if it is not one. */
function payloads(data: Buffer): Buffer[] | undefined {
  const found: Buffer[] = [];
  for (let at = 0; at < data.length;) {
    const hex = data.toString('latin1', at, at + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) return undefined;
    const size = Number.parseInt(hex, 16);
    if (size < 4) {
      at += 4;
      continue;
    }
    if (at + size > data.length) return undefined;
    found.push(data.subarray(at + 4, at + size));
    at += size;
  }
  return found;
}

/** A pack of no objects: what a push sends when the host has everything already. */
export function emptyPack(sha256: boolean): Buffer {
  const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  const checksum = createHash(sha256 ? 'sha256' : 'sha1')
    .update(header)
    .digest();
  return Buffer.concat([header, checksum]);
}
