import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  approveTask,
  archiveInbox,
  createRemoteSocket,
  getSession,
  getSupervisorSession,
  getTask,
  listInbox,
  listProjects,
  listSessions,
  listTasks,
  markInboxRead,
  pairDevice,
  pauseTask,
  resumeTask,
  sendSessionMessage,
  sendSupervisorMessage,
  sendTaskBack,
  stopSessionRuntime,
  stopTaskActivity,
  type MailboxMessage,
  type ProjectSummary,
  type SessionRecord,
  type TaskDetail,
  type TaskSummary,
} from "./src/api";
import { clearStoredConnection, loadStoredConnection, saveStoredConnection, type StoredConnection } from "./src/storage";

type TabId = "tasks" | "inbox" | "chat" | "sessions" | "settings";

function formatTime(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function defaultHostUrlDraft() {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const url = new URL(window.location.href);
    url.port = "49500";
    url.protocol = url.protocol === "https:" ? "https:" : "http:";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }
  return "http://192.0.2.10:49500";
}

function normalizePairedBaseUrlForWeb(enteredBaseUrl: string, pairedBaseUrl?: string | null) {
  if (Platform.OS !== "web") {
    return pairedBaseUrl ?? enteredBaseUrl;
  }
  return enteredBaseUrl;
}

function currentWebDriverUrl() {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.location.origin;
  }
  return null;
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [connection, setConnection] = useState<StoredConnection | null>(null);
  const [hostUrlDraft, setHostUrlDraft] = useState(defaultHostUrlDraft);
  const [pairingCodeDraft, setPairingCodeDraft] = useState("");
  const [deviceLabelDraft, setDeviceLabelDraft] = useState("My phone");
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [inbox, setInbox] = useState<MailboxMessage[]>([]);
  const [supervisorSession, setSupervisorSession] = useState<SessionRecord | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionRecord | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [sessionDraft, setSessionDraft] = useState("");
  const [tab, setTab] = useState<TabId>("tasks");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const refreshTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const webDriverUrl = useMemo(() => currentWebDriverUrl(), []);
  const suggestedApiUrl = useMemo(() => defaultHostUrlDraft(), []);

  useEffect(() => {
    void (async () => {
      try {
        const stored = await loadStoredConnection();
        if (stored) {
          setConnection(stored);
          setHostUrlDraft(stored.baseUrl);
          setDeviceLabelDraft(stored.deviceLabel);
        }
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  async function loadCoreData(baseUrl = connection?.baseUrl, token = connection?.token, preferredProjectId?: string | null) {
    if (!baseUrl || !token) return;
    setLoading(true);
    setError(null);
    try {
      const nextProjects = await listProjects(baseUrl, token);
      setProjects(nextProjects);
      const resolvedProjectId = preferredProjectId ?? activeProjectId ?? nextProjects[0]?.id ?? null;
      setActiveProjectId(resolvedProjectId);
      if (resolvedProjectId) {
        const [nextTasks, nextInbox, nextSupervisor, nextSessions] = await Promise.all([
          listTasks(baseUrl, token, resolvedProjectId),
          listInbox(baseUrl, token, resolvedProjectId),
          getSupervisorSession(baseUrl, token, resolvedProjectId),
          listSessions(baseUrl, token, resolvedProjectId),
        ]);
        setTasks(nextTasks);
        setInbox(nextInbox);
        setSupervisorSession(nextSupervisor);
        setSessions(nextSessions);
        setSelectedTaskId((current) => current && nextTasks.some((task) => task.id === current) ? current : nextTasks[0]?.id ?? null);
        setSelectedSessionId((current) => current && nextSessions.some((session) => session.id === current) ? current : nextSessions[0]?.id ?? nextSupervisor.id);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load Orchestra data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (connection) {
      void loadCoreData();
    }
  }, [connection?.baseUrl, connection?.token]);

  useEffect(() => {
    if (!connection || !activeProjectId) return;
    void (async () => {
      try {
        const [nextTasks, nextInbox, nextSupervisor, nextSessions] = await Promise.all([
          listTasks(connection.baseUrl, connection.token, activeProjectId),
          listInbox(connection.baseUrl, connection.token, activeProjectId),
          getSupervisorSession(connection.baseUrl, connection.token, activeProjectId),
          listSessions(connection.baseUrl, connection.token, activeProjectId),
        ]);
        setTasks(nextTasks);
        setInbox(nextInbox);
        setSupervisorSession(nextSupervisor);
        setSessions(nextSessions);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Unable to refresh project data.");
      }
    })();
  }, [activeProjectId]);

  useEffect(() => {
    if (!connection || !selectedTaskId) {
      setSelectedTask(null);
      return;
    }
    void getTask(connection.baseUrl, connection.token, selectedTaskId)
      .then(setSelectedTask)
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Unable to load task detail."));
  }, [connection?.baseUrl, connection?.token, selectedTaskId]);

  useEffect(() => {
    if (!connection || !selectedSessionId) {
      setSelectedSession(null);
      return;
    }
    void getSession(connection.baseUrl, connection.token, selectedSessionId)
      .then(setSelectedSession)
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : "Unable to load session detail."));
  }, [connection?.baseUrl, connection?.token, selectedSessionId]);

  function scheduleSessionRefresh(sessionId: string) {
    if (!connection) return;
    if (refreshTimeouts.current[sessionId]) {
      clearTimeout(refreshTimeouts.current[sessionId]);
    }
    refreshTimeouts.current[sessionId] = setTimeout(() => {
      void getSession(connection.baseUrl, connection.token, sessionId)
        .then((session) => {
          if (supervisorSession?.id === sessionId) {
            setSupervisorSession(session);
          }
          if (selectedSessionId === sessionId) {
            setSelectedSession(session);
          }
        })
        .catch(() => undefined);
    }, 400);
  }

  useEffect(() => {
    if (!connection) {
      socketRef.current?.close();
      socketRef.current = null;
      return;
    }

    const socket = createRemoteSocket(connection.baseUrl, connection.token);
    socketRef.current = socket;

    socket.onopen = () => {
      if (activeProjectId) {
        socket.send(JSON.stringify({ type: "select_project", projectId: activeProjectId }));
      }
      if (supervisorSession?.id) {
        socket.send(JSON.stringify({ type: "subscribe_session", sessionId: supervisorSession.id }));
      }
      if (selectedSessionId) {
        socket.send(JSON.stringify({ type: "subscribe_session", sessionId: selectedSessionId }));
      }
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as { type?: string; event?: { topic?: string; sessionId?: string | null } };
        if (parsed.type !== "event" || !parsed.event) {
          return;
        }
        if (parsed.event.topic === "task.updated") {
          if (activeProjectId && connection) {
            void listTasks(connection.baseUrl, connection.token, activeProjectId).then(setTasks).catch(() => undefined);
          }
          if (selectedTaskId && connection) {
            void getTask(connection.baseUrl, connection.token, selectedTaskId).then(setSelectedTask).catch(() => undefined);
          }
        }
        if (parsed.event.topic === "inbox.updated") {
          void listInbox(connection.baseUrl, connection.token, activeProjectId).then(setInbox).catch(() => undefined);
        }
        if ((parsed.event.topic === "session.updated" || parsed.event.topic === "session.stream") && parsed.event.sessionId) {
          scheduleSessionRefresh(parsed.event.sessionId);
        }
      } catch {
        // Ignore malformed websocket messages.
      }
    };

    return () => {
      socket.close();
    };
  }, [connection?.baseUrl, connection?.token, activeProjectId, supervisorSession?.id, selectedSessionId]);

  async function handlePair() {
    setPairingBusy(true);
    setPairingError(null);
    try {
      const enteredBaseUrl = hostUrlDraft.trim();
      const response = await pairDevice(enteredBaseUrl, pairingCodeDraft.trim(), deviceLabelDraft.trim(), Platform.OS);
      const nextConnection: StoredConnection = {
        baseUrl: normalizePairedBaseUrlForWeb(enteredBaseUrl, response.baseUrl),
        token: response.token,
        deviceLabel: deviceLabelDraft.trim() || "Mobile device",
      };
      await saveStoredConnection(nextConnection);
      setConnection(nextConnection);
    } catch (nextError) {
      setPairingError(nextError instanceof Error ? nextError.message : "Unable to pair with Orchestra host.");
    } finally {
      setPairingBusy(false);
    }
  }

  async function handleApproveTask() {
    if (!connection || !selectedTask) return;
    setBusyAction("approve");
    try {
      const updated = await approveTask(connection.baseUrl, connection.token, selectedTask.id);
      setSelectedTask(updated);
      await loadCoreData(connection.baseUrl, connection.token, activeProjectId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to approve task.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSendTaskBack() {
    if (!connection || !selectedTask) return;
    setBusyAction("needs-work");
    try {
      const updated = await sendTaskBack(connection.baseUrl, connection.token, selectedTask.id);
      setSelectedTask(updated);
      await loadCoreData(connection.baseUrl, connection.token, activeProjectId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to send task back.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleResumeTask() {
    if (!connection || !selectedTask) return;
    setBusyAction("resume");
    try {
      const updated = await resumeTask(connection.baseUrl, connection.token, selectedTask.id);
      setSelectedTask(updated);
      await loadCoreData(connection.baseUrl, connection.token, activeProjectId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to resume task.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePauseTask() {
    if (!connection || !selectedTask) return;
    setBusyAction("pause");
    try {
      const updated = await pauseTask(connection.baseUrl, connection.token, selectedTask.id);
      setSelectedTask(updated);
      await loadCoreData(connection.baseUrl, connection.token, activeProjectId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to pause task.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleStopTaskActivity() {
    if (!connection || !selectedTask) return;
    setBusyAction("stop-task");
    try {
      const updated = await stopTaskActivity(connection.baseUrl, connection.token, selectedTask.id);
      setSelectedTask(updated);
      await loadCoreData(connection.baseUrl, connection.token, activeProjectId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to stop task activity.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleStopSelectedSession() {
    if (!connection || !selectedSession) return;
    setBusyAction("stop-session");
    try {
      const updated = await stopSessionRuntime(connection.baseUrl, connection.token, selectedSession.id);
      setSelectedSession(updated);
      await loadCoreData(connection.baseUrl, connection.token, activeProjectId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to stop session runtime.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSendSupervisorMessage() {
    if (!connection || !activeProjectId || !chatDraft.trim()) return;
    setBusyAction("chat");
    try {
      await sendSupervisorMessage(connection.baseUrl, connection.token, activeProjectId, chatDraft.trim());
      setChatDraft("");
      if (supervisorSession) {
        scheduleSessionRefresh(supervisorSession.id);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to send supervisor message.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSendSessionMessage() {
    if (!connection || !selectedSession || !sessionDraft.trim()) return;
    setBusyAction("session");
    try {
      await sendSessionMessage(connection.baseUrl, connection.token, selectedSession.id, sessionDraft.trim());
      setSessionDraft("");
      scheduleSessionRefresh(selectedSession.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to send session message.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDisconnect() {
    await clearStoredConnection();
    socketRef.current?.close();
    socketRef.current = null;
    setConnection(null);
    setProjects([]);
    setTasks([]);
    setSelectedTask(null);
    setInbox([]);
    setSupervisorSession(null);
    setSessions([]);
    setSelectedSession(null);
  }

  if (booting) {
    return (
      <SafeAreaView style={styles.centeredScreen}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  if (!connection) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.connectContainer}>
          <Text style={styles.title}>Connect to Orchestra</Text>
          <Text style={styles.subtitle}>Pair this Android/iOS client with an Orchestra host using the remote driver API.</Text>
          {Platform.OS === "web" ? (
            <View style={styles.helperCard} testID="web-driver-helper-card">
              <Text style={styles.helperTitle}>Shared web driver</Text>
              <Text style={styles.helperText}>Keep this page open on the web driver URL, then pair against the API URL below. The page URL and API URL use the same host but different ports.</Text>
              {webDriverUrl ? <Text style={styles.helperText} testID="web-driver-current-url">Current web driver URL: {webDriverUrl}</Text> : null}
              <Text style={styles.helperText} testID="web-driver-suggested-api-url">Suggested API URL: {suggestedApiUrl}</Text>
              <Pressable style={styles.secondaryButton} onPress={() => setHostUrlDraft(suggestedApiUrl)} testID="web-driver-use-current-host">
                <Text style={styles.secondaryButtonText}>Use current page host</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>API host URL</Text>
            <TextInput
              style={styles.input}
              value={hostUrlDraft}
              onChangeText={setHostUrlDraft}
              placeholder="Host URL"
              autoCapitalize="none"
              testID="connect-host-url"
            />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Pairing code</Text>
            <TextInput
              style={styles.input}
              value={pairingCodeDraft}
              onChangeText={setPairingCodeDraft}
              placeholder="Pairing code"
              autoCapitalize="characters"
              testID="connect-pairing-code"
            />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Device label</Text>
            <TextInput
              style={styles.input}
              value={deviceLabelDraft}
              onChangeText={setDeviceLabelDraft}
              placeholder="Device label"
              testID="connect-device-label"
            />
          </View>
          {pairingError ? <Text style={styles.errorText}>{pairingError}</Text> : null}
          <Pressable style={styles.primaryButton} onPress={() => void handlePair()} testID="connect-pair-device">
            <Text style={styles.primaryButtonText}>{pairingBusy ? "Pairing…" : "Pair device"}</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>Orchestra Mobile</Text>
          <Text style={styles.title}>{activeProject?.name ?? "Loading project…"}</Text>
        </View>
        {loading ? <ActivityIndicator /> : null}
      </View>

      <ScrollView horizontal style={styles.tabBar} contentContainerStyle={styles.tabBarContent} showsHorizontalScrollIndicator={false}>
        {(["tasks", "inbox", "chat", "sessions", "settings"] as TabId[]).map((entry) => (
          <Pressable key={entry} style={[styles.tabButton, tab === entry ? styles.tabButtonActive : null]} onPress={() => setTab(entry)}>
            <Text style={[styles.tabButtonText, tab === entry ? styles.tabButtonTextActive : null]}>{entry.toUpperCase()}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {tab === "tasks" ? (
        <ScrollView contentContainerStyle={styles.content}>
          <ProjectPicker projects={projects} activeProjectId={activeProjectId} onSelect={setActiveProjectId} />
          {tasks.map((task) => (
            <Pressable key={task.id} style={[styles.card, selectedTaskId === task.id ? styles.cardSelected : null]} onPress={() => setSelectedTaskId(task.id)}>
              <Text style={styles.cardTitle}>{task.number} · {task.title}</Text>
              <Text style={styles.cardMeta}>{task.status} · {task.priority} · {task.currentLaneId ?? "no lane"}</Text>
            </Pressable>
          ))}
          {selectedTask ? (
            <View style={styles.detailCard}>
              <Text style={styles.detailTitle}>{selectedTask.number} · {selectedTask.title}</Text>
              <Text style={styles.cardMeta}>{selectedTask.status} · {selectedTask.priority}</Text>
              <Text style={styles.bodyText}>{selectedTask.description?.trim() || "No description."}</Text>
              <View style={styles.row}>
                {selectedTask.activeLaneAssignment?.status === "awaiting_user_approval" ? (
                  <>
                    <Pressable style={styles.secondaryButton} onPress={() => void handleApproveTask()}>
                      <Text style={styles.secondaryButtonText}>{busyAction === "approve" ? "Approving…" : "Approve"}</Text>
                    </Pressable>
                    <Pressable style={styles.secondaryButton} onPress={() => void handleSendTaskBack()}>
                      <Text style={styles.secondaryButtonText}>{busyAction === "needs-work" ? "Sending…" : "Needs work"}</Text>
                    </Pressable>
                  </>
                ) : null}
                {["awaiting_user_intervention", "paused_by_user"].includes(selectedTask.activeLaneAssignment?.status ?? "") ? (
                  <Pressable style={styles.secondaryButton} onPress={() => void handleResumeTask()}>
                    <Text style={styles.secondaryButtonText}>{busyAction === "resume" ? "Resuming…" : "Resume"}</Text>
                  </Pressable>
                ) : null}
                {["active", "queued"].includes(selectedTask.activeLaneAssignment?.status ?? "") ? (
                  <Pressable style={styles.secondaryButton} onPress={() => void handlePauseTask()}>
                    <Text style={styles.secondaryButtonText}>{busyAction === "pause" ? "Pausing…" : "Pause"}</Text>
                  </Pressable>
                ) : null}
                {selectedTask.activeLaneAssignment ? (
                  <Pressable style={styles.secondaryButton} onPress={() => void handleStopTaskActivity()}>
                    <Text style={styles.secondaryButtonText}>{busyAction === "stop-task" ? "Stopping…" : "Stop"}</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.sectionTitle}>Comments</Text>
              {selectedTask.comments.length ? selectedTask.comments.map((comment) => (
                <View key={comment.id} style={styles.commentRow}>
                  <Text style={styles.commentAuthor}>{comment.author}</Text>
                  <Text style={styles.commentMessage}>{comment.message}</Text>
                </View>
              )) : <Text style={styles.bodyText}>No comments yet.</Text>}
            </View>
          ) : null}
        </ScrollView>
      ) : null}

      {tab === "inbox" ? (
        <ScrollView contentContainerStyle={styles.content}>
          <ProjectPicker projects={projects} activeProjectId={activeProjectId} onSelect={setActiveProjectId} />
          {inbox.length ? inbox.map((message) => (
            <View key={message.deliveryId} style={styles.card}>
              <Text style={styles.cardTitle}>{message.senderLabel} · {message.taskNumber ?? "No task"}</Text>
              <Text style={styles.bodyText}>{message.body}</Text>
              <Text style={styles.cardMeta}>{message.priority} · {formatTime(message.createdAt)}</Text>
              <View style={styles.row}>
                <Pressable style={styles.secondaryButton} onPress={() => void markInboxRead(connection.baseUrl, connection.token, message.deliveryId).then(() => loadCoreData())}>
                  <Text style={styles.secondaryButtonText}>Mark read</Text>
                </Pressable>
                <Pressable style={styles.secondaryButton} onPress={() => void archiveInbox(connection.baseUrl, connection.token, message.deliveryId).then(() => loadCoreData())}>
                  <Text style={styles.secondaryButtonText}>Archive</Text>
                </Pressable>
              </View>
            </View>
          )) : <Text style={styles.bodyText}>Inbox is empty.</Text>}
        </ScrollView>
      ) : null}

      {tab === "chat" ? (
        <View style={styles.flexContent}>
          <ProjectPicker projects={projects} activeProjectId={activeProjectId} onSelect={setActiveProjectId} compact />
          <ScrollView contentContainerStyle={styles.content}>
            {(supervisorSession?.events ?? []).map((event) => (
              <View key={event.id} style={styles.commentRow}>
                <Text style={styles.commentAuthor}>{event.kind}</Text>
                <Text style={styles.commentMessage}>{event.message}</Text>
                <Text style={styles.cardMeta}>{formatTime(event.timestamp)}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.composer}>
            <TextInput style={styles.input} value={chatDraft} onChangeText={setChatDraft} placeholder="Message the supervisor" />
            <Pressable style={styles.primaryButton} onPress={() => void handleSendSupervisorMessage()}>
              <Text style={styles.primaryButtonText}>{busyAction === "chat" ? "Sending…" : "Send"}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {tab === "sessions" ? (
        <View style={styles.flexContent}>
          <ProjectPicker projects={projects} activeProjectId={activeProjectId} onSelect={setActiveProjectId} compact />
          <ScrollView horizontal style={styles.sessionScroller} contentContainerStyle={styles.sessionScrollerContent}>
            {sessions.map((session) => (
              <Pressable
                key={session.id}
                style={[styles.sessionChip, selectedSessionId === session.id ? styles.sessionChipActive : null]}
                onPress={() => {
                  setSelectedSessionId(session.id);
                  socketRef.current?.send(JSON.stringify({ type: "subscribe_session", sessionId: session.id }));
                }}
              >
                <Text style={selectedSessionId === session.id ? styles.sessionChipTextActive : styles.sessionChipText}>{session.title}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <ScrollView contentContainerStyle={styles.content}>
            {(selectedSession?.events ?? []).map((event) => (
              <View key={event.id} style={styles.commentRow}>
                <Text style={styles.commentAuthor}>{event.kind}</Text>
                <Text style={styles.commentMessage}>{event.message}</Text>
                <Text style={styles.cardMeta}>{formatTime(event.timestamp)}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.composer}>
            <TextInput style={styles.input} value={sessionDraft} onChangeText={setSessionDraft} placeholder="Send to session" />
            <Pressable style={styles.primaryButton} onPress={() => void handleSendSessionMessage()}>
              <Text style={styles.primaryButtonText}>{busyAction === "session" ? "Sending…" : "Send"}</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={() => void handleStopSelectedSession()}>
              <Text style={styles.secondaryButtonText}>{busyAction === "stop-session" ? "Stopping…" : "Stop"}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {tab === "settings" ? (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.detailCard}>
            <Text style={styles.detailTitle}>Connection</Text>
            <Text style={styles.bodyText}>Host: {connection.baseUrl}</Text>
            <Text style={styles.bodyText}>Device: {connection.deviceLabel}</Text>
            <Pressable style={styles.secondaryButton} onPress={() => void handleDisconnect()}>
              <Text style={styles.secondaryButtonText}>Disconnect</Text>
            </Pressable>
          </View>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

function ProjectPicker({ projects, activeProjectId, onSelect, compact = false }: { projects: ProjectSummary[]; activeProjectId: string | null; onSelect: (value: string) => void; compact?: boolean }) {
  return (
    <ScrollView horizontal style={compact ? styles.projectPickerCompact : styles.projectPicker} contentContainerStyle={styles.projectPickerContent} showsHorizontalScrollIndicator={false}>
      {projects.map((project) => (
        <Pressable key={project.id} style={[styles.projectChip, activeProjectId === project.id ? styles.projectChipActive : null]} onPress={() => onSelect(project.id)}>
          <Text style={activeProjectId === project.id ? styles.projectChipTextActive : styles.projectChipText}>{project.name}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#f3f5f9",
  },
  centeredScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f3f5f9",
  },
  connectContainer: {
    flexGrow: 1,
    padding: 24,
    gap: 12,
    justifyContent: "center",
  },
  helperCard: {
    backgroundColor: "#e8f0ff",
    borderRadius: 16,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: "#bfdbfe",
  },
  helperTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1d4ed8",
  },
  helperText: {
    color: "#1f2937",
    lineHeight: 20,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  eyebrow: {
    fontSize: 12,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#111827",
  },
  subtitle: {
    color: "#4b5563",
    fontSize: 15,
  },
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
  },
  tabBar: {
    maxHeight: 56,
  },
  tabBarContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  tabButton: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: "#e5e7eb",
  },
  tabButtonActive: {
    backgroundColor: "#111827",
  },
  tabButtonText: {
    color: "#374151",
    fontWeight: "600",
  },
  tabButtonTextActive: {
    color: "white",
  },
  content: {
    padding: 16,
    gap: 12,
  },
  flexContent: {
    flex: 1,
  },
  card: {
    backgroundColor: "white",
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  cardSelected: {
    borderWidth: 2,
    borderColor: "#2563eb",
  },
  detailCard: {
    backgroundColor: "white",
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111827",
  },
  detailTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  cardMeta: {
    fontSize: 12,
    color: "#6b7280",
  },
  bodyText: {
    color: "#374151",
    lineHeight: 20,
  },
  input: {
    backgroundColor: "white",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#d1d5db",
  },
  primaryButton: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: "white",
    fontWeight: "700",
  },
  secondaryButton: {
    backgroundColor: "#e5e7eb",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  secondaryButtonText: {
    color: "#111827",
    fontWeight: "600",
  },
  errorText: {
    color: "#b91c1c",
    paddingHorizontal: 20,
  },
  row: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111827",
  },
  commentRow: {
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  commentAuthor: {
    fontSize: 12,
    fontWeight: "700",
    color: "#374151",
    textTransform: "uppercase",
  },
  commentMessage: {
    color: "#111827",
    lineHeight: 20,
  },
  composer: {
    padding: 16,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
  },
  projectPicker: {
    maxHeight: 52,
  },
  projectPickerCompact: {
    maxHeight: 44,
  },
  projectPickerContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  projectChip: {
    backgroundColor: "#dbeafe",
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  projectChipActive: {
    backgroundColor: "#1d4ed8",
  },
  projectChipText: {
    color: "#1e3a8a",
    fontWeight: "600",
  },
  projectChipTextActive: {
    color: "white",
    fontWeight: "700",
  },
  sessionScroller: {
    maxHeight: 54,
  },
  sessionScrollerContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  sessionChip: {
    backgroundColor: "#e5e7eb",
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  sessionChipActive: {
    backgroundColor: "#111827",
  },
  sessionChipText: {
    color: "#374151",
  },
  sessionChipTextActive: {
    color: "white",
  },
});
