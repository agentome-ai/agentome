import { describe, expect, it } from 'vitest';
import { FLUSH, parsePushHead, pkt, refusedRefs, reportStatus } from './pktline.js';

describe("the host's report of a push", () => {
  const results = [
    { ref: 'refs/heads/agent/one' },
    { ref: 'refs/heads/agent/two', refusal: 'stale info' },
  ];

  it('names the refs the host refused, in side-band or not', () => {
    for (const capabilities of [[], ['side-band'], ['side-band-64k', 'report-status']]) {
      expect(refusedRefs(reportStatus(results, capabilities), capabilities)).toEqual(
        new Set(['refs/heads/agent/two']),
      );
    }
  });

  it('reads past progress in band 2 and the option lines of report-status-v2', () => {
    const report = Buffer.concat([
      pkt('unpack ok\n'),
      pkt('ok refs/heads/agent/one\n'),
      pkt('option refname refs/heads/agent/one\n'),
      pkt('ng refs/heads/agent/two non-fast-forward\n'),
      FLUSH,
    ]);
    const answer = Buffer.concat([
      pkt(Buffer.concat([Buffer.from([2]), Buffer.from('Resolving deltas\n')])),
      pkt(Buffer.concat([Buffer.from([1]), report])),
      FLUSH,
    ]);
    expect(refusedRefs(answer, ['side-band-64k'])).toEqual(new Set(['refs/heads/agent/two']));
  });

  it('names none for a push that asked for no report, and cannot tell from what is not pkt-lines', () => {
    expect(refusedRefs(Buffer.alloc(0), [])).toEqual(new Set());
    expect(refusedRefs(Buffer.from('<html>Bad gateway</html>'), [])).toBeUndefined();
    expect(refusedRefs(Buffer.from('00ffng refs/heads/agent/cut'), [])).toBeUndefined();
  });
});

describe('the head of a push', () => {
  const command = `${'0'.repeat(40)} ${'1'.repeat(40)} refs/heads/agent/one`;
  const capabilitiesOf = (list: string) => {
    const head = parsePushHead(Buffer.concat([pkt(`${command}\0${list}\n`), FLUSH]));
    return typeof head === 'string' ? head : head.capabilities;
  };

  it('names the capabilities as git reads them: up to whitespace or `=`', () => {
    expect(
      capabilitiesOf('report-status-v2 side-band-64k object-format=sha1 agent=git/2.54.0'),
    ).toEqual(['report-status-v2', 'side-band-64k', 'object-format', 'agent']);
    expect(capabilitiesOf('report-status push-options=1')).toContain('push-options');
    expect(capabilitiesOf('report-status\tpush-options')).toContain('push-options');
    expect(capabilitiesOf(' report-status  \r push-options')).toContain('push-options');
  });
});
