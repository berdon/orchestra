import { useMemo, useState } from "react";

import { SUPERVISOR_POLICY_ID, getPolicyLabel, hasSupervisorAccess, togglePolicy } from "../../lib/access";
import type { PolicyDefinition } from "../../types";
import { AccessSummary, type InheritedAccessSummary } from "./AccessSummary";
import { PermissionCatalog } from "./PermissionCatalog";

interface AccessEditorProps {
  actorLabel: string;
  dataRolePrefix: string;
  policyIds?: string[];
  directPermissions?: string[];
  attachedPolicies: PolicyDefinition[];
  effectivePermissions: string[];
  grantsFullAccess: boolean;
  inheritedAccess?: InheritedAccessSummary | null;
  locked?: boolean;
  onPolicyIdsChange: (policyIds: string[]) => void;
  onDirectPermissionsChange: (permissions: string[]) => void;
}

export function AccessEditor({
  actorLabel,
  dataRolePrefix,
  policyIds,
  directPermissions,
  attachedPolicies,
  effectivePermissions,
  grantsFullAccess,
  inheritedAccess,
  locked,
  onPolicyIdsChange,
  onDirectPermissionsChange,
}: AccessEditorProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const selectedPermissions = directPermissions ?? [];
  const supervisorAccess = locked || hasSupervisorAccess(policyIds);

  const attachedPolicyNames = useMemo(() => {
    const names = attachedPolicies.map((policy) => getPolicyLabel(policy));
    if (supervisorAccess && !attachedPolicies.some((policy) => policy.id === SUPERVISOR_POLICY_ID)) {
      names.unshift("Supervisor");
    }
    return Array.from(new Set(names));
  }, [attachedPolicies, supervisorAccess]);

  return (
    <section className="workflow-section">
      <div className="workflow-section__header">
        <div>
          <p className="eyebrow">Access</p>
          <h3>Permissions</h3>
        </div>
        {locked ? <span className="status-badge status-badge--warning">Protected</span> : null}
      </div>

      <AccessSummary
        dataRolePrefix={dataRolePrefix}
        attachedPolicyNames={attachedPolicyNames}
        effectivePermissions={effectivePermissions}
        grantsFullAccess={grantsFullAccess}
        inheritedAccess={inheritedAccess}
      />

      <div className="access-controls">
        <label className="permission-row permission-row--toggle">
          <input
            data-role={`${dataRolePrefix}-supervisor-toggle`}
            type="checkbox"
            checked={supervisorAccess}
            disabled={locked}
            onChange={(event) => onPolicyIdsChange(togglePolicy(policyIds, SUPERVISOR_POLICY_ID, event.target.checked))}
          />
          <div className="permission-row__copy">
            <strong>Grant supervisor access</strong>
            <span className="muted-copy">Supervisor access grants the full Orchestra permission surface.</span>
            <p>
              {locked
                ? `Supervisor access is required for this protected ${actorLabel}.`
                : `Enable this to attach the built-in immutable supervisor policy to the ${actorLabel}.`}
            </p>
          </div>
        </label>

        <PermissionCatalog
          dataRolePrefix={dataRolePrefix}
          selectedPermissions={selectedPermissions}
          disabled={locked}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onPermissionsChange={onDirectPermissionsChange}
        />
      </div>
    </section>
  );
}
