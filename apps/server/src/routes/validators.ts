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

/** A host an admin opens to the runs in places: a name, `*.suffix` for every name under it, or IPv4. */
export const HostPattern = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^(\d{1,3}\.){3}\d{1,3}$/,
    'A host name, *.example.com, or an IPv4 address',
  );
