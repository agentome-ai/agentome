import { describe as group, expect, it } from 'vitest';
import { describe } from './approvals-data';

group("a team lead's assignment in Approvals", () => {
  const members = [
    { id: 'a1', name: 'Backend developer' },
    { id: 'a2', name: 'Frontend developer' },
  ];

  it('says which step starts and who works in it', () => {
    expect(
      describe({
        tool: 'team_step',
        task: null,
        input: { step: 2, members, description: 'Build the refund API' },
      }),
    ).toEqual({
      refs: [],
      action: 'Start step 2: Backend developer, Frontend developer',
      body: 'Build the refund API',
    });
  });

  it('says who gets the work in an auto team', () => {
    expect(
      describe({ tool: 'team_step', task: null, input: { step: null, members: [members[0]] } }),
    ).toEqual({
      refs: [],
      action: 'Give work to Backend developer',
      body: undefined,
    });
  });
});
