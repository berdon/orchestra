import { useEffect, useMemo, useState } from "react";

import { listAgents } from "../lib/agents";
import {
  dispatchRoleQueue,
  disposeRoleInstance,
  enqueueRoleWork,
  getRoleOperations,
  listRoleOperations,
  releaseRoleInstance,
} from "../lib/roleRuntime";
import { RoleOperationsDetail } from "./RoleOperationsDetail";
import type { AgentSummary, RoleOperationsDetail as RoleOperationsDetailModel, RoleOperationsSnapshot } from "../types";

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [roleSnapshots, setRoleSnapshots] = useState<RoleOperationsSnapshot[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [selectedRoleDetail, setSelectedRoleDetail] = useState<RoleOperationsDetailModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSnapshot = useMemo(
    () => roleSnapshots.find((role) => role.role.id === selectedRoleId) ?? roleSnapshots[0] ?? null,
    [selectedRoleId, roleSnapshots],
  );

  async function loadRoleDetail(roleId: string) {
    setLoading(true);
    setError(null);

    try {
      const detail = await getRoleOperations(roleId);
      setSelectedRoleDetail(detail);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load role operations.");
    } finally {
      setLoading(false);
    }
  }

  async function loadWorkforce() {
    setLoading(true);
    setError(null);

    try {
      const [nextAgents, nextRoleSnapshots] = await Promise.all([listAgents(), listRoleOperations()]);
      setAgents(nextAgents);
      setRoleSnapshots(nextRoleSnapshots);
      setSelectedRoleId((current) => {
        if (current && nextRoleSnapshots.some((role) => role.role.id === current)) {
          return current;
        }
        return nextRoleSnapshots[0]?.role.id ?? null;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load workforce operations.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadWorkforce();
  }, []);

  useEffect(() => {
    if (!selectedSnapshot?.role.id) {
      setSelectedRoleDetail(null);
      return;
    }

    void loadRoleDetail(selectedSnapshot.role.id);
  }, [selectedSnapshot?.role.id]);

  async function refreshSelectedRole(roleId: string) {
    const [snapshots, detail] = await Promise.all([listRoleOperations(), getRoleOperations(roleId)]);
    setRoleSnapshots(snapshots);
    setSelectedRoleDetail(detail);
  }

  async function runBusyAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Workforce action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="workforce-shell">
      <aside className="workforce-nav-panel">
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Workforce</p>
            <h2>Roles in operation</h2>
          </div>
          <button className="secondary-button" type="button" disabled={loading || busy} onClick={() => void loadWorkforce()}>
            Refresh
          </button>
        </div>

        {error ? <p className="error-copy">{error}</p> : null}
        {loading ? <p className="muted-copy">Loading workforce…</p> : null}

        <nav className="workforce-role-nav" aria-label="Role operations">
          {roleSnapshots.map((snapshot) => (
            <a
              key={snapshot.role.id}
              className={snapshot.role.id === selectedSnapshot?.role.id ? "workforce-role-link workforce-role-link--active" : "workforce-role-link"}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setSelectedRoleId(snapshot.role.id);
              }}
            >
              {snapshot.role.name}
            </a>
          ))}
        </nav>

        <div className="workforce-agent-group">
          <div>
            <p className="eyebrow">Named agents</p>
            <h3>Persistent collaborators</h3>
          </div>

          {agents.length === 0 ? <p className="muted-copy">No agents yet.</p> : null}
          <nav className="workforce-agent-nav" aria-label="Named agents">
            {agents.map((agent) => (
              <span className="workforce-agent-link" key={agent.id}>
                {agent.name} · {agent.thinkingLevel}
              </span>
            ))}
          </nav>
        </div>
      </aside>

      <section className="panel workforce-detail-panel">
        {selectedRoleDetail ? (
          <RoleOperationsDetail
            detail={selectedRoleDetail}
            busy={busy}
            onDispatch={() => runBusyAction(async () => refreshSelectedRole((await dispatchRoleQueue(selectedRoleDetail.role.id)).role.id))}
            onEnqueue={(input) =>
              runBusyAction(async () => {
                await enqueueRoleWork({
                  roleId: selectedRoleDetail.role.id,
                  sourceType: "manual",
                  title: input.title,
                  summary: input.summary,
                  entryPrompt: input.entryPrompt,
                });
                await refreshSelectedRole(selectedRoleDetail.role.id);
              })
            }
            onRelease={(instanceId, outcome) =>
              runBusyAction(async () => {
                const detail = await releaseRoleInstance(instanceId, outcome, outcome === "failure" ? "Marked failed by operator." : undefined);
                await refreshSelectedRole(detail.role.id);
              })
            }
            onDispose={(instanceId) =>
              runBusyAction(async () => {
                const detail = await disposeRoleInstance(instanceId);
                await refreshSelectedRole(detail.role.id);
              })
            }
          />
        ) : (
          <div className="empty-state">
            <p className="eyebrow">No role selected</p>
            <h3>Choose a role</h3>
            <p>Select a role from the workforce list to inspect queue pressure, runtime instances, and disposable worktree state.</p>
          </div>
        )}
      </section>
    </section>
  );
}
