import { describe, expect, test } from "vitest";

import {
  SUPERVISOR_POLICY_ID,
  buildEffectivePermissions,
  filterPermissionOptions,
  groupPermissionOptions,
  hasSupervisorAccess,
  togglePermission,
  togglePolicy,
} from "../src/lib/access";

describe("access helpers", () => {
  test("toggles policies and permissions without duplicates", () => {
    expect(togglePolicy([], SUPERVISOR_POLICY_ID, true)).toEqual([SUPERVISOR_POLICY_ID]);
    expect(togglePolicy([SUPERVISOR_POLICY_ID], SUPERVISOR_POLICY_ID, true)).toEqual([SUPERVISOR_POLICY_ID]);
    expect(togglePermission(["roles.dispatch"], "roles.dispatch", true)).toEqual(["roles.dispatch"]);
    expect(togglePermission(["roles.dispatch"], "roles.dispatch", false)).toEqual([]);
  });

  test("detects supervisor access and computes full access", () => {
    expect(hasSupervisorAccess([SUPERVISOR_POLICY_ID])).toBe(true);
    expect(hasSupervisorAccess([])).toBe(false);

    const effective = buildEffectivePermissions({
      inheritedPermissions: ["tasks.read"],
      attachedPolicies: [
        {
          id: SUPERVISOR_POLICY_ID,
          slug: "supervisor",
          name: "Supervisor",
          permissions: ["*"],
          system: true,
          immutable: true,
          createdAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        },
      ],
      directPermissions: ["roles.dispatch"],
    });

    expect(effective.grantsFullAccess).toBe(true);
    expect(effective.permissions).toContain("*");
    expect(effective.permissions).toContain("tasks.read");
    expect(effective.permissions).toContain("roles.dispatch");
  });

  test("filters and groups permissions for the catalog", () => {
    expect(filterPermissionOptions("dispatch").map((option) => option.key)).toContain("roles.dispatch");
    expect(filterPermissionOptions("skill").map((option) => option.key)).toContain("skills.read");
    expect(groupPermissionOptions("session").some((group) => group.group === "Sessions")).toBe(true);
    expect(groupPermissionOptions("skill").some((group) => group.group === "Skills" && group.options.some((option) => option.key === "skills.assign"))).toBe(true);
  });
});
