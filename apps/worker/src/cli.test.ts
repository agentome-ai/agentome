import { describe, expect, it } from 'vitest';
import { serverUrlOf } from './cli.js';

describe("the server's address", () => {
  it('takes HTTPS anywhere, and plain HTTP only to this machine or a service by its name', () => {
    expect(serverUrlOf('https://agentome.example.com/')).toBe('https://agentome.example.com');
    expect(serverUrlOf('https://10.0.4.12:8443/agentome/')).toBe('https://10.0.4.12:8443/agentome');
    expect(serverUrlOf('http://localhost:4440')).toBe('http://localhost:4440');
    expect(serverUrlOf('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(serverUrlOf('http://[::1]:3000')).toBe('http://[::1]:3000');
    expect(serverUrlOf('http://app:3000')).toBe('http://app:3000');
    expect(serverUrlOf('http://agentome:3000')).toBe('http://agentome:3000');
    for (const across of ['http://192.168.10.20:4440', 'http://agentome.example.com']) {
      expect(() => serverUrlOf(across)).toThrow(/plain HTTP across a network/);
    }
    expect(() => serverUrlOf('ftp://x')).toThrow(/not a server address/);
  });
});
