import { useEffect, useMemo, useRef, useState } from "react";

import { deleteAgentQueueEntry, getAgentOperations, listAgentOperations } from "../lib/agents";
import {
  dispatchRoleQueue,
  disposeRoleInstance,
  enqueueRoleWork,
  getRoleOperations,
  listRoleOperations,
  releaseRoleInstance,
} from "../lib/roleRuntime";
import { AgentOperationsDetail } from "./AgentOperationsDetail";
import { RoleOperationsDetail } from "./RoleOperationsDetail";
import type {
  AgentOperationsDetail as AgentOperationsDetailModel,
  AgentOperationsSnapshot,
  RoleOperationsDetail as RoleOperationsDetailModel,
  RoleOperationsSnapshot,
} from "../types";

interface AgentsPageProps {
  activeProjectId?: string | null;
  selectedWorkerRequest?: { type: "role" | "agent"; id: string; token: number } | null;
  onOpenAgentSession: (agentId: string) => void;
}

export function AgentsPage({ activeProjectId = null, selectedWorkerRequest = null, onOpenAgentSession }: AgentsPageProps) {
  const [agentSnapshots, setAgentSnapshots] = useState<AgentOperationsSnapshot[]>([]);
  const [roleSnapshots, setRoleSnapshots] = useState<RoleOperationsSnapshot[]>([]);
  const [selectedWorker, setSelectedWorker] = useState<{ type: "role" | "agent"; id: string } | null>(null);
  const [selectedRoleDetail, setSelectedRoleDetail] = useState<RoleOperationsDetailModel | null>(null);
  const [selectedAgentDetail, setSelectedAgentDetail] = useState<AgentOperationsDetailModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedWorkerRequestTokenRef = useRef<number>(0);

  const selectedRoleSnapshot = useMemo(
    () => selectedWorker?.type === "role" ? roleSnapshots.find((role) => role.role.id === selectedWorker.id) ?? null : null,
    [selectedWorker, roleSnapshots],
  );

  const selectedAgentSnapshot = useMemo(
    () => selectedWorker?.type === "agent" ? agentSnapshots.find((agent) => agent.agent.id === selectedWorker.id) ?? null : null,
    [selectedWorker, agentSnapshots],
  );

  async function loadRoleDetail(roleId: string) {
    setLoading(true);
    setError(null);

    try {
      const detail = await getRoleOperations(roleId);
      setSelectedRoleDetail(detail);
      setSelectedAgentDetail(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load role operations.");
    } finally {
      setLoading(false);
    }
  }

  async function loadAgentDetail(agentId: string) {
    setLoading(true);
    setError(null);

    try {
      const detail = await getAgentOperations(agentId, activeProjectId);
      setSelectedAgentDetail(detail);
      setSelectedRoleDetail(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load agent operations.");
    } finally {
      setLoading(false);
    }
  }

  async function loadWorkforce() {
    setLoading(true);
    setError(null);

    try {
      const [nextAgentSnapshots, nextRoleSnapshots] = await Promise.all([listAgentOperations(false, activeProjectId), listRoleOperations()]);
      setAgentSnapshots(nextAgentSnapshots);
      setRoleSnapshots(nextRoleSnapshots);
      setSelectedWorker((current) => {
        if (current?.type === "role" && nextRoleSnapshots.some((role) => role.role.id === current.id)) {
          return current;
        }
        if (current?.type === "agent" && nextAgentSnapshots.some((agent) => agent.agent.id === current.id)) {
          return current;
        }
        if (nextRoleSnapshots[0]) {
          return { type: "role", id: nextRoleSnapshots[0].role.id };
        }
        if (nextAgentSnapshots[0]) {
          return { type: "agent", id: nextAgentSnapshots[0].agent.id };
        }
        return null;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load workforce operations.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadWorkforce();
  }, [activeProjectId]);

  useEffect(() => {
    if (!selectedWorker) {
      setSelectedRoleDetail(null);
      setSelectedAgentDetail(null);
      return;
    }

    if (selectedWorker.type === "role") {
      void loadRoleDetail(selectedWorker.id);
      return;
    }

    void loadAgentDetail(selectedWorker.id);
  }, [selectedWorker?.id, selectedWorker?.type]);

  useEffect(() => {
    if (!selectedWorkerRequest || selectedWorkerRequest.token === selectedWorkerRequestTokenRef.current) {
      return;
    }

    selectedWorkerRequestTokenRef.current = selectedWorkerRequest.token;
    setSelectedWorker({ type: selectedWorkerRequest.type, id: selectedWorkerRequest.id });
  }, [selectedWorkerRequest]);

  async function refreshSelectedRole(roleId: string) {
    const [roleOps, detail, nextAgentSnapshots] = await Promise.all([listRoleOperations(), getRoleOperations(roleId), listAgentOperations(false, activeProjectId)]);
    setRoleSnapshots(roleOps);
    setAgentSnapshots(nextAgentSnapshots);
    setSelectedWorker({ type: "role", id: roleId });
    setSelectedRoleDetail(detail);
  }

  async function refreshSelectedAgent(agentId: string) {
    const [detail, nextAgentSnapshots] = await Promise.all([getAgentOperations(agentId, activeProjectId), listAgentOperations(false, activeProjectId)]);
    setAgentSnapshots(nextAgentSnapshots);
    setSelectedWorker({ type: "agent", id: agentId });
    setSelectedAgentDetail(detail);
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
              className={snapshot.role.id === selectedRoleSnapshot?.role.id ? "workforce-role-link workforce-role-link--active" : "workforce-role-link"}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setSelectedWorker({ type: "role", id: snapshot.role.id });
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

          {agentSnapshots.length === 0 ? <p className="muted-copy">No agents yet.</p> : null}
          <nav className="workforce-agent-nav" aria-label="Named agents">
            {agentSnapshots.map((agentSnapshot) => (
              <a
                className={agentSnapshot.agent.id === selectedAgentSnapshot?.agent.id ? "workforce-agent-link workforce-agent-link--active" : "workforce-agent-link"}
                href="#"
                key={agentSnapshot.agent.id}
                onClick={(event) => {
                  event.preventDefault();
                  setSelectedWorker({ type: "agent", id: agentSnapshot.agent.id });
                }}
              >
                <strong>{agentSnapshot.agent.name}</strong>
                <span className="task-list-link__meta">
                  <span>{agentSnapshot.runtimeState.status}</span>
                  <span>{agentSnapshot.queuedCount} queued</span>
                </span>
              </a>
            ))}
          </nav>
        </div>
      </aside>

      <section className="panel workforce-detail-panel">
        {selectedWorker?.type === "role" && selectedRoleDetail ? (
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
        ) : selectedWorker?.type === "agent" && selectedAgentDetail ? (
          <AgentOperationsDetail
            busy={busy}
            detail={selectedAgentDetail}
            onDeleteQueuedEntry={(queueEntryId) =>
              runBusyAction(async () => {
                await deleteAgentQueueEntry(queueEntryId);
                await refreshSelectedAgent(selectedAgentDetail.agent.id);
              })
            }
            onOpenSession={onOpenAgentSession}
          />
        ) : (
          <div className="empty-state">
            <p className="eyebrow">No worker selected</p>
            <h3>Choose a worker</h3>
            <p>Select a role or agent to inspect project-scoped runtime state, queue pressure, sessions, and execution details.</p>
          </div>
        )}
      </section>
    </section>
  );
}
