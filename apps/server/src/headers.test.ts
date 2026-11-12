import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, inlineScriptHashes } from './headers.js';

describe('the content security policy', () => {
  it('names the terminal socket of an HTTPS address, and GitHub for the release check', () => {
    const policy = contentSecurityPolicy('https://agentome.corp.example', []);
    expect(policy).toContain(
      "connect-src 'self' wss://agentome.corp.example https://api.github.com",
    );
    expect(policy).toContain("script-src 'self';");
  });

  it('hashes inline scripts only, not those loaded from a file', () => {
    const hashes = inlineScriptHashes(
      '<script>a()</script><script type="module" src="/assets/x.js"></script><script>\n b()\n</script>',
    );
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
  });
});
