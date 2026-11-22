import { describe, expect, it } from 'vitest';
import { HostPattern } from './validators.js';

describe('a host an admin opens to places', () => {
  it('takes a star over a company’s own domain, not over one strangers share', () => {
    const takes = (pattern: string) => HostPattern.safeParse(pattern).success;
    for (const pattern of [
      '*.co.uk',
      '*.com.au',
      '*.amazonaws.com',
      '*.s3.amazonaws.com',
      '*.github.io',
      '*.vercel.app',
    ]) {
      expect(takes(pattern), pattern).toBe(false);
    }
    // A company's own, under a country's second level; one name in full under a shared domain.
    for (const pattern of [
      '*.corp.co.uk',
      '*.jira.corp.example',
      'builds.s3.amazonaws.com',
      'acme.github.io',
    ]) {
      expect(takes(pattern), pattern).toBe(true);
    }
  });
});
