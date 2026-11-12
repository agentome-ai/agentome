import { describe, expect, it } from 'vitest';
import { egressOf } from './run.js';

// In a person's place, a run's CLI calls out under the run's own token, not the place's.

describe("a run's way out", () => {
  it("puts the run's token on the place's egress proxy, for every proxy variable", () => {
    const place = {
      AGENTOME_PLACE_EGRESS: 'place-egress:3128',
      HTTPS_PROXY: 'http://p1:the-place-token@place-egress:3128',
      https_proxy: 'http://p1:the-place-token@place-egress:3128',
      NO_PROXY: 'app,localhost,127.0.0.1',
    };
    const env = egressOf(place, 'run/token+1');
    const expected = 'http://run:run%2Ftoken%2B1@place-egress:3128';
    expect([env.HTTPS_PROXY, env.HTTP_PROXY, env.https_proxy, env.http_proxy]).toEqual([
      expected,
      expected,
      expected,
      expected,
    ]);
    expect(env.NO_PROXY).toBe('app,localhost,127.0.0.1');
    expect(JSON.stringify(env)).not.toContain('the-place-token');
  });

  it("reaches the project's services beside the agent directly, by their names", () => {
    const env = egressOf(
      { AGENTOME_PLACE_EGRESS: 'place-egress:3128', NO_PROXY: 'app,localhost,127.0.0.1' },
      'token',
      ['db', 'cache'],
    );
    expect(env.NO_PROXY).toBe('app,localhost,127.0.0.1,db,cache');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('leaves a computer or a server seat as it is', () => {
    const env = { HTTPS_PROXY: 'http://corp-proxy:8080' };
    expect(egressOf(env, 'run token')).toBe(env);
  });
});
