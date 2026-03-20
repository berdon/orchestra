import { getPermissionLabel } from "../../lib/access";

export interface InheritedAccessSummary {
  sourceLabel: string;
  permissions: string[];
  policyNames: string[];
  grantsFullAccess: boolean;
}

interface AccessSummaryProps {
  dataRolePrefix: string;
  attachedPolicyNames: string[];
  effectivePermissions: string[];
  grantsFullAccess: boolean;
  inheritedAccess?: InheritedAccessSummary | null;
}

export function AccessSummary({
  dataRolePrefix,
  attachedPolicyNames,
  effectivePermissions,
  grantsFullAccess,
  inheritedAccess,
}: AccessSummaryProps) {
  return (
    <section className="access-summary" data-role={`${dataRolePrefix}-effective-access`}>
      <div className="access-summary__badges">
        {grantsFullAccess ? <span className="status-badge status-badge--warning">Full access</span> : null}
        <span className="status-badge status-badge--neutral">{effectivePermissions.length} effective</span>
        {inheritedAccess ? <span className="status-badge status-badge--accent">Inherited from {inheritedAccess.sourceLabel}</span> : null}
      </div>

      <div className="access-summary__copy">
        <strong>
          {grantsFullAccess
            ? "This actor currently has full Orchestra access."
            : effectivePermissions.length > 0
              ? "This actor can use the selected protected Orchestra actions."
              : "No protected Orchestra access is currently granted."}
        </strong>
        <p>
          {grantsFullAccess
            ? "Supervisor access grants the full Orchestra tool and command surface."
            : inheritedAccess
              ? `Effective permissions include inherited access from ${inheritedAccess.sourceLabel} plus any direct grants shown below.`
              : "Add direct permissions or supervisor access to let this actor use protected Orchestra actions."}
        </p>
      </div>

      {attachedPolicyNames.length > 0 ? (
        <div className="access-summary__group">
          <span className="field-group__label">Attached policies</span>
          <div className="access-chip-list">
            {attachedPolicyNames.map((name) => (
              <span className="access-chip access-chip--policy" key={name}>
                {name}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {inheritedAccess ? (
        <div className="access-summary__group" data-role={`${dataRolePrefix}-inherited-access`}>
          <span className="field-group__label">Inherited access</span>
          <p className="muted-copy access-summary__hint">Edit the source role to change inherited access.</p>
          {inheritedAccess.policyNames.length > 0 ? (
            <div className="access-chip-list">
              {inheritedAccess.policyNames.map((name) => (
                <span className="access-chip access-chip--readonly" key={name}>
                  {name}
                </span>
              ))}
            </div>
          ) : null}
          <div className="access-chip-list">
            {inheritedAccess.permissions.map((permission) => (
              <span className="access-chip access-chip--readonly" key={permission}>
                {getPermissionLabel(permission)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {effectivePermissions.length > 0 ? (
        <div className="access-summary__group">
          <span className="field-group__label">Effective permissions</span>
          <div className="access-chip-list">
            {effectivePermissions.map((permission) => (
              <span className="access-chip access-chip--effective" key={permission}>
                {permission === "*" ? "All permissions (*)" : getPermissionLabel(permission)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
