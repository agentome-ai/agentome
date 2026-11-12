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
