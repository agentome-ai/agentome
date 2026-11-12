import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// What every answer tells the browser about itself. The page may run only its own scripts, and
// the one inline script of index.html by its hash; it loads images and fonts only from itself, so
// a link or picture an agent wrote cannot call another site when shown; no other site may frame
// it, so nothing lays a page over Approve; over HTTPS the browser keeps to HTTPS.

/** The hashes of index.html's inline scripts, as CSP names them. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = match[1] ?? '';
    hashes.push(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
  }
  return hashes;
}

/** The Content-Security-Policy of the web app at `publicUrl`. */
export function contentSecurityPolicy(publicUrl: string, scriptHashes: string[]): string {
  const url = new URL(publicUrl);
  // The terminal of a place is a WebSocket of this server; some browsers do not count it 'self'.
  const socket = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    // React and Radix set style attributes, and index.html has its splash's styles inline.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Admin asks GitHub for the latest release from the admin's own browser.
    `connect-src 'self' ${socket} https://api.github.com`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function addSecurityHeaders(
  app: FastifyInstance,
  options: { publicUrl: string; webDir?: string },
) {
  const hashes = options.webDir
    ? inlineScriptHashes(readFileSync(join(options.webDir, 'index.html'), 'utf8'))
    : [];
  const policy = contentSecurityPolicy(options.publicUrl, hashes);
  const https = new URL(options.publicUrl).protocol === 'https:';
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('content-security-policy', policy);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    // Half a year; the subdomains are the company's to decide.
    if (https) reply.header('strict-transport-security', 'max-age=15552000');
    return payload;
  });
}
