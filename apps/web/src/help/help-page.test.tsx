import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, mockApi } from '../test-api';

describe('the help page', () => {
  it('lists the keyboard shortcuts by where they work', async () => {
    mockApi({ 'GET /api/me': admin });
    render(
      <MemoryRouter initialEntries={['/help']}>
        <App />
      </MemoryRouter>,
    );
    const anywhere = await screen.findByRole('region', { name: 'Anywhere' });
    expect(within(anywhere).getByText('Search and jump to a page')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Agent editor' }).textContent).toContain('S');
  });
});
