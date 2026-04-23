import type {
  InboxChangeEvent,
  SessionChangeEvent,
  SessionStreamEnvelope,
  TaskChangeEvent,
} from "../../types";

export const ORCHESTRA_BROWSER_EVENT_NAMES = {
  sessionStream: "orchestra:session-stream",
  sessionChange: "orchestra:session-change",
  taskChange: "orchestra:task-change",
  inboxChange: "orchestra:inbox-change",
} as const;

function dispatchOrchestraBrowserEvent<T>(eventName: string, detail: T) {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

export function emitMockSessionStream(event: SessionStreamEnvelope) {
  dispatchOrchestraBrowserEvent(ORCHESTRA_BROWSER_EVENT_NAMES.sessionStream, event);
}

export function emitMockSessionChange(event: SessionChangeEvent) {
  dispatchOrchestraBrowserEvent(ORCHESTRA_BROWSER_EVENT_NAMES.sessionChange, event);
}

export function emitMockTaskChange(event: TaskChangeEvent) {
  dispatchOrchestraBrowserEvent(ORCHESTRA_BROWSER_EVENT_NAMES.taskChange, event);
}

export function emitMockInboxChange(event: InboxChangeEvent) {
  dispatchOrchestraBrowserEvent(ORCHESTRA_BROWSER_EVENT_NAMES.inboxChange, event);
}
