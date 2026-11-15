import { useNavigate } from 'react-router';
import { api } from '../api';
import { TwoStepSetup } from '../settings/two-step';
import { Button } from '../ui/button';
import { AuthPage } from './auth-page';

// Where an admin who signs in with a password lands until they set up the second step: the
// server answers two_factor_required to everything else they ask.
export function TwoStepPage() {
  const navigate = useNavigate();
  return (
    <AuthPage
      title="Set up two-step sign-in"
      description="Admins sign in with a code from an authenticator app as well as their password. Confirm your password to start."
    >
      <TwoStepSetup onDone={() => navigate('/', { replace: true })} />
      <Button
        variant="quiet"
        className="mt-6"
        onClick={() =>
          void api('/api/auth/sign-out', { body: {} }).finally(() =>
            navigate('/login', { replace: true }),
          )
        }
      >
        Sign out
      </Button>
    </AuthPage>
  );
}
