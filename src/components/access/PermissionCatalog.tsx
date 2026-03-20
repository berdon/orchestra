import { getPermissionLabel, groupPermissionOptions, togglePermission } from "../../lib/access";

interface PermissionCatalogProps {
  dataRolePrefix: string;
  selectedPermissions: string[];
  disabled?: boolean;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onPermissionsChange: (permissions: string[]) => void;
}

export function PermissionCatalog({
  dataRolePrefix,
  selectedPermissions,
  disabled,
  searchQuery,
  onSearchQueryChange,
  onPermissionsChange,
}: PermissionCatalogProps) {
  const groups = groupPermissionOptions(searchQuery);

  return (
    <div className="access-catalog">
      <div className="access-catalog__header">
        <label className="field-group access-catalog__search">
          <span className="field-group__label">Search permissions</span>
          <input
            className="text-input"
            data-role={`${dataRolePrefix}-permission-search`}
            type="search"
            value={searchQuery}
            placeholder="Search by name, key, or group"
            onChange={(event) => onSearchQueryChange(event.target.value)}
          />
        </label>
        <span className="muted-copy">{selectedPermissions.length} selected</span>
      </div>

      {selectedPermissions.length > 0 ? (
        <div className="access-summary__group">
          <span className="field-group__label">Direct grants</span>
          <div className="access-chip-list">
            {selectedPermissions.map((permission) => (
              <button
                key={permission}
                className="access-chip access-chip--removable"
                data-role={`${dataRolePrefix}-selected-permission-${permission}`}
                type="button"
                disabled={disabled}
                onClick={() => onPermissionsChange(togglePermission(selectedPermissions, permission, false))}
              >
                {getPermissionLabel(permission)}
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="permission-group-list" data-role={`${dataRolePrefix}-permissions-grid`}>
        {groups.map(({ group, options }) => (
          <section className="permission-group" key={group}>
            <div className="permission-group__header">
              <h4>{group}</h4>
              <span className="muted-copy">{options.length} options</span>
            </div>
            <div className="permission-group__options">
              {options.map((option) => {
                const checked = selectedPermissions.includes(option.key);
                return (
                  <label className="permission-row" key={option.key}>
                    <input
                      data-role={`${dataRolePrefix}-permission-${option.key}`}
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={(event) => onPermissionsChange(togglePermission(selectedPermissions, option.key, event.target.checked))}
                    />
                    <div className="permission-row__copy">
                      <strong>{option.label}</strong>
                      <span className="muted-copy">{option.key}</span>
                      {option.description ? <p>{option.description}</p> : null}
                    </div>
                  </label>
                );
              })}
            </div>
          </section>
        ))}

        {groups.length === 0 ? <p className="muted-copy">No permissions match the current search.</p> : null}
      </div>
    </div>
  );
}
