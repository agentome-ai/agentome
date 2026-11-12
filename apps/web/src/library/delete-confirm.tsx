import { useState } from 'react';
import { api, asApiError } from '../api';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { FormError } from '../ui/field';

type Item = { owner: { id: string } | null; visibility: 'org' | 'private' };

/** Its author deletes an item, and an admin a shared one; nobody the ones Agentome ships. */
export const canDelete = (item: Item, me: { id: string; role: string }) =>
  item.owner !== null &&
  (item.owner.id === me.id || (me.role === 'admin' && item.visibility === 'org'));

const said = {
  server: 'Agents that have it lose its tools from their next run, and its token is deleted too.',
  skill: 'Every version goes. Agents that have it lose it from their next run.',
};

/**
 * The question in place of the item's dialog content, not a second dialog over it: Cancel
 * goes back to the item.
 */
export function DeleteConfirm(props: {
  kind: 'server' | 'skill';
  name: string;
  url: string;
  onCancel: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function remove() {
    setPending(true);
    setError(undefined);
    try {
      await api(props.url, { method: 'DELETE' });
      await props.onDeleted();
    } catch (caught) {
      setError(asApiError(caught).message);
      setPending(false);
    }
  }

  return (
    <>
      <D.DialogTitle>Delete {props.name}?</D.DialogTitle>
      <D.DialogDescription>{said[props.kind]}</D.DialogDescription>
      {error && <FormError>{error}</FormError>}
      <D.DialogFooter>
        <Button variant="secondary" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button variant="danger" disabled={pending} onClick={() => void remove()}>
          Delete {props.kind}
        </Button>
      </D.DialogFooter>
    </>
  );
}
