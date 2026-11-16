import { and, catalogItems, type Db, eq, inArray, isNull } from '@agentome/db';
import { z } from 'zod';
import { createAgent } from '../agents/service.js';
import { AppError } from '../errors.js';
import { requireRoomFor } from '../license/service.js';
import { createTeam, NewTeam } from './service.js';

// The team templates the platform ships, as data: a lead and members named by role
// template, and the steps they work in. Creating a team from one creates its agents from
// those role templates; like a role template, it is a prefill, and the team is then the person's.

export const TeamTemplate = z.object({
  name: z.string(),
  /** One line for the picker. */
  description: z.string(),
  /** Role template names: the lead's, then the members' in the team's order. */
  lead: z.string(),
  members: z.array(z.string()),
  steps: z.array(z.object({ members: z.array(z.string()), note: z.string() })),
});
type TeamTemplate = z.infer<typeof TeamTemplate>;

// Five agents: what Free holds, so the template works without a license key.
export const teamTemplates: TeamTemplate[] = [
  {
    name: 'Development team',
    description:
      'A lead and four engineers take a task through building, review and testing to one change request.',
    lead: 'Development lead',
    members: ['Backend developer', 'Frontend developer', 'Code reviewer', 'QA engineer'],
    steps: [
      {
        members: ['Backend developer', 'Frontend developer'],
        note: 'The code and its tests are committed on the branch, and the checks pass',
      },
      { members: ['Code reviewer'], note: 'Every finding is fixed or answered' },
      { members: ['QA engineer'], note: 'Every acceptance criterion is checked' },
    ],
  },
];

export const FromTemplate = z.object({
  template: z.string(),
  name: NewTeam.shape.name.optional(),
});

/**
 * Creates a template's agents, owned by the person, and the team they make in manual mode.
 * Room on Free is checked for all of them before the first is created.
 */
export async function createTeamFromTemplate(
  db: Db,
  userId: string,
  input: z.infer<typeof FromTemplate>,
) {
  const template = teamTemplates.find((item) => item.name === input.template);
  if (!template) throw new AppError('not_found', 'Team template not found');
  const roles = [template.lead, ...template.members];
  const rows = await db
    .select({ id: catalogItems.id, name: catalogItems.name })
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.kind, 'template'),
        isNull(catalogItems.ownerUserId),
        inArray(catalogItems.name, roles),
      ),
    );
  await requireRoomFor(db, 'agents', roles.length);
  await requireRoomFor(db, 'teams');
  const ids = new Map<string, string>();
  for (const role of roles) {
    const templateId = rows.find((row) => row.name === role)?.id;
    // The role templates are seeded on every start, so a missing one is a bug here.
    if (!templateId) throw new Error(`No role template named ${role}`);
    ids.set(role, (await createAgent(db, userId, { name: role, templateId })).id);
  }
  const idOf = (role: string) => ids.get(role) ?? '';
  return createTeam(db, userId, {
    name: input.name ?? template.name,
    leadId: idOf(template.lead),
    mode: 'manual',
    members: template.members.map(idOf),
    steps: template.steps.map((step) => ({ agents: step.members.map(idOf), note: step.note })),
  });
}
