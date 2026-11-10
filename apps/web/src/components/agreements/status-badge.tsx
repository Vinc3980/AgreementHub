import type { AgreementStatus, VersionStatus } from '@agreementhub/domain';
import { Badge } from '@/components/ui/badge';
import { StatusStamp, VersionStamp } from '@/components/ui/status-stamp';

/** Agreement lifecycle stamp: glyph + label, never colour alone. */
export function StatusBadge({ status }: { status: AgreementStatus | string }) {
  return <StatusStamp status={status} />;
}

/** Version stamp: distinguishes working draft vs sealed FINAL. */
export function VersionBadge({ status }: { status: VersionStatus | string }) {
  return <VersionStamp status={status} />;
}

/** Party role label. */
export function RoleBadge({ role }: { role: string }) {
  return (
    <Badge tone={role === 'OWNER' ? 'brand' : role === 'SIGNER' ? 'info' : 'neutral'}>
      {role.charAt(0) + role.slice(1).toLowerCase()}
    </Badge>
  );
}

/** Compact row of lifecycle stamps used where the full track is too wide. */
export function LifecyclePills({
  status,
  versionStatus,
  verified,
}: {
  status: AgreementStatus | string;
  versionStatus?: VersionStatus | string | null;
  verified?: boolean;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <StatusStamp status={status} />
      {versionStatus === 'FINAL' ? <VersionStamp status="FINAL" /> : null}
      {verified ? (
        <Badge tone="success">
          <span aria-hidden>●</span> Verified
        </Badge>
      ) : null}
    </span>
  );
}
