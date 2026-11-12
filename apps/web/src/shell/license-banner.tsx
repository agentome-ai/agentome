import { Link } from 'react-router';
import { licenseDay, useLicense } from '../admin/license-data';
import { textLink } from '../ui/properties';

/**
 * A line over every page when the license needs someone: in a key's grace,
 * what happens when it ends; over Free without a key, that Agentome is read-only. Nothing on
 * Free or while a key holds.
 */
export function LicenseBanner({ admin }: { admin: boolean }) {
  const { license } = useLicense();
  if (!license || (license.status !== 'grace' && license.status !== 'read_only')) return null;
  const fix = admin ? (
    <Link to="/admin/license" className={textLink}>
      {license.status === 'read_only' ? 'Add a license key or cut back' : 'Add a new license key'}
    </Link>
  ) : (
    'Ask an admin.'
  );
  const readOnly = license.status === 'read_only';
  return (
    <p
      role="status"
      className={
        readOnly
          ? 'border-b border-line bg-raised px-6 py-2.5 text-small text-ink max-md:px-4'
          : 'border-b border-line bg-raised px-6 py-2.5 text-small text-ink-2 max-md:px-4'
      }
    >
      <span
        aria-hidden="true"
        className={`mr-2 inline-block size-1.5 -translate-y-px rounded-full ${readOnly ? 'bg-failed' : 'bg-waiting'}`}
      />
      {readOnly ? (
        <>
          <b className="font-medium">Agentome is read-only.</b> It is over Free without a license
          key: you can look at everything, but nothing runs or changes. {fix}
        </>
      ) : (
        <>
          The license ended on {licenseDay(license.expiresAt ?? '')}. On{' '}
          {licenseDay(license.graceEndsAt ?? '')} Agentome{' '}
          {license.over.length > 0 ? 'turns read-only, being over Free' : 'goes back to Free'}.{' '}
          {fix}
        </>
      )}
    </p>
  );
}
