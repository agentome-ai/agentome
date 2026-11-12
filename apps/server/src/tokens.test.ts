import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  bearerToken,
  hashSecret,
  newPairingCode,
  newToken,
  normalizePairingCode,
} from './tokens.js';

const withAuthorization = (authorization?: string) =>
  ({ headers: { authorization } }) as unknown as FastifyRequest;

describe('tokens', () => {
  it('are 32 random bytes in base64url, stored as their SHA-256', () => {
    const { token, hash } = newToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(hashSecret(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken().token).not.toBe(token);
  });

  it('are read from a bearer header and nothing else', () => {
    const { token } = newToken();
    expect(bearerToken(withAuthorization(`Bearer ${token}`))).toBe(token);
    expect(bearerToken(withAuthorization(`bearer ${token}`))).toBe(token);
    expect(bearerToken(withAuthorization(token))).toBeUndefined();
    expect(bearerToken(withAuthorization(`Bearer ${token}x`))).toBeUndefined();
    expect(bearerToken(withAuthorization('Bearer '))).toBeUndefined();
    expect(bearerToken(withAuthorization())).toBeUndefined();
  });
});

describe('pairing codes', () => {
  it('are XXXX-XXXX without characters people confuse', () => {
    const codes = Array.from({ length: 200 }, newPairingCode);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('are the same code however a person types them', () => {
    for (const typed of ['abcd-efgh', 'ABCDEFGH', ' abcd efgh ', 'Abcd–Efgh']) {
      expect(normalizePairingCode(typed)).toBe('ABCD-EFGH');
    }
    expect(normalizePairingCode('abc')).toBe('ABC');
  });
});
