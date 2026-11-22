import { z } from 'zod';

// Validators more than one route module writes against; what belongs to one API stays there.

/** Text as PostgreSQL stores it: no NUL, and never longer than the column expects. */
export const Text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\0]*$/, 'Remove the NUL character.');

/** A name a person types: trimmed, not empty, short enough to show in a list. */
export const Name = z.string().trim().min(1).max(100);

/**
 * A host an admin opens to the runs in places: a full name (two labels at least, so neither the
 * platform's own services nor a whole top-level domain), `*.domain.tld` for every name under it,
 * or an IPv4 address; with `:port` when not 443. Never this machine or link-local addresses.
 */
export const HostPattern = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?$/,
    'A full host name, *.example.com or an IPv4 address, with :port when not 443',
  )
  .refine((pattern) => {
    const [host = '', port] = pattern.split(':');
    if (port !== undefined && !(Number(port) >= 1 && Number(port) <= 65_535)) return false;
    // `*.com` has one label under the star: the whole domain.
    if (host.startsWith('*.') && !host.slice(2).includes('.')) return false;
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
    if (ip) {
      const [first, second] = [Number(ip[1]), Number(ip[2])];
      if (host.split('.').some((part) => Number(part) > 255)) return false;
      if (first === 0 || first === 127 || (first === 169 && second === 254) || first >= 224) {
        return false;
      }
    }
    return true;
  }, 'Not a host a place may reach: this machine, link-local addresses and whole top-level domains are refused')
  .refine(
    (pattern) => !pattern.startsWith('*.') || !shared(pattern.slice(2).split(':')[0] ?? ''),
    'A star over a domain many companies share opens all of them: name the host in full',
  );

/**
 * Domains under which strangers get names of their own: a country's second level (co.uk,
 * com.au) and the clouds' and code hosts' shared ones. A star over one of them is everyone's.
 */
const SHARED = [
  'amazonaws.com',
  'cloudfront.net',
  'azurewebsites.net',
  'azureedge.net',
  'cloudapp.net',
  'cloudapp.azure.com',
  'windows.net',
  'appspot.com',
  'googleusercontent.com',
  'googleapis.com',
  'run.app',
  'web.app',
  'firebaseapp.com',
  'github.io',
  'githubusercontent.com',
  'gitlab.io',
  'herokuapp.com',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'r2.dev',
  'fly.dev',
  'onrender.com',
  'ngrok.io',
  'ngrok-free.app',
  'trycloudflare.com',
  'digitaloceanspaces.com',
  'ondigitalocean.app',
];
const COUNTRY_SECOND =
  /^(?:co|com|net|org|ac|edu|gov|gob|go|ne|or|mil|nic|ltd|plc|sch|me|info|biz)\.[a-z]{2}$/;

function shared(domain: string): boolean {
  if (COUNTRY_SECOND.test(domain)) return true;
  return SHARED.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`));
}
