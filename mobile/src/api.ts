export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

export interface TaskSummary {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  currentLaneId?: string | null;
  updatedAt: string;
}

export interface TaskComment {
  id: string;
  author: string;
  message: string;
  createdAt: string;
}

export interface TaskDetail extends TaskSummary {
  description?: string | null;
  comments: TaskComment[];
}

export interface MailboxMessage {
  deliveryId: string;
  senderLabel: string;
  body: string;
  priority: string;
  readAt?: string | null;
  archivedAt?: string | null;
  taskId?: string | null;
  taskNumber?: string | null;
  createdAt: string;
}

export interface SessionEvent {
  id: string;
  kind: string;
  message: string;
  timestamp: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  events: SessionEvent[];
}

export interface RemoteAuthResponse {
  token: string;
  baseUrl?: string | null;
  websocketUrl?: string | null;
}

export interface QueuedSessionMessage {
  sessionId: string;
  runId: string;
  message: string;
  timestamp: string;
}

export interface RemoteEventEnvelope {
  topic: string;
  sessionId?: string | null;
  payload: unknown;
}

async function request<T>(baseUrl: string, path: string, token?: string | null, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function pairDevice(baseUrl: string, code: string, label: string, platform: string): Promise<RemoteAuthResponse> {
  return request<RemoteAuthResponse>(baseUrl, "/api/v1/pair/complete", null, {
    method: "POST",
    body: JSON.stringify({ code, label, platform }),
  });
}

export async function listProjects(baseUrl: string, token: string) {
  return request<ProjectSummary[]>(baseUrl, "/api/v1/projects", token);
}

export async function listTasks(baseUrl: string, token: string, projectId: string) {
  return request<TaskSummary[]>(baseUrl, `/api/v1/projects/${projectId}/tasks`, token);
}

export async function getTask(baseUrl: string, token: string, taskId: string) {
  return request<TaskDetail>(baseUrl, `/api/v1/tasks/${taskId}`, token);
}

export async function approveTask(baseUrl: string, token: string, taskId: string) {
  return request<TaskDetail>(baseUrl, `/api/v1/tasks/${taskId}/approve`, token, { method: "POST" });
}

export async function sendTaskBack(baseUrl: string, token: string, taskId: string) {
  return request<TaskDetail>(baseUrl, `/api/v1/tasks/${taskId}/needs-work`, token, { method: "POST" });
}

export async function listInbox(baseUrl: string, token: string, projectId?: string | null) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return request<MailboxMessage[]>(baseUrl, `/api/v1/inbox${query}`, token);
}

export async function markInboxRead(baseUrl: string, token: string, deliveryId: string) {
  return request<MailboxMessage[]>(baseUrl, `/api/v1/inbox/${deliveryId}/read`, token, { method: "POST" });
}

export async function archiveInbox(baseUrl: string, token: string, deliveryId: string) {
  return request<MailboxMessage[]>(baseUrl, `/api/v1/inbox/${deliveryId}/archive`, token, { method: "POST" });
}

export async function getSupervisorSession(baseUrl: string, token: string, projectId: string) {
  return request<SessionRecord>(baseUrl, `/api/v1/projects/${projectId}/supervisor`, token);
}

export async function sendSupervisorMessage(baseUrl: string, token: string, projectId: string, message: string) {
  return request<QueuedSessionMessage>(baseUrl, `/api/v1/projects/${projectId}/supervisor/message`, token, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export async function listSessions(baseUrl: string, token: string, projectId?: string | null) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return request<SessionRecord[]>(baseUrl, `/api/v1/sessions${query}`, token);
}

export async function getSession(baseUrl: string, token: string, sessionId: string) {
  return request<SessionRecord>(baseUrl, `/api/v1/sessions/${sessionId}`, token);
}

export async function sendSessionMessage(baseUrl: string, token: string, sessionId: string, message: string) {
  return request<QueuedSessionMessage>(baseUrl, `/api/v1/sessions/${sessionId}/message`, token, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export function createRemoteSocket(baseUrl: string, token: string) {
  const websocketBase = baseUrl.replace(/^http/i, "ws");
  return new WebSocket(`${websocketBase}/api/v1/ws?token=${encodeURIComponent(token)}`);
}
