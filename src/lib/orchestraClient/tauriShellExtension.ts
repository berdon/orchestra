import {
  getCurrentAgentTerminalSessionId,
  getInitialAgentTerminalSessionId,
  getInitialAgentTerminalWindowFlag,
  getInitialLogsWindowFlag,
  isCurrentAgentTerminalWindow,
  isCurrentLogsWindow,
  openLogsWindow,
} from "../tauri";
import {
  getAgentTerminalBuffer,
  openAgentSessionInTerminal,
  resizeAgentTerminal,
  shutdownAgentTerminalSession,
  writeAgentTerminalInput,
} from "../agents";
import type { OrchestraShellExtension } from "./extensions";

export function createTauriShellExtension(): OrchestraShellExtension {
  return {
    getInitialWindowState() {
      return {
        isLogsWindow: getInitialLogsWindowFlag(),
        isAgentTerminalWindow: getInitialAgentTerminalWindowFlag(),
        agentTerminalSessionId: getInitialAgentTerminalSessionId(),
      };
    },
    async getWindowState() {
      const [logsWindow, agentTerminalWindow, agentTerminalSessionId] = await Promise.all([
        isCurrentLogsWindow(),
        isCurrentAgentTerminalWindow(),
        getCurrentAgentTerminalSessionId(),
      ]);

      return {
        isLogsWindow: logsWindow,
        isAgentTerminalWindow: agentTerminalWindow,
        agentTerminalSessionId,
      };
    },
    openLogsWindow,
    agentTerminal: {
      openSession: openAgentSessionInTerminal,
      writeInput: writeAgentTerminalInput,
      resize: resizeAgentTerminal,
      getBuffer: getAgentTerminalBuffer,
      shutdown: shutdownAgentTerminalSession,
    },
  };
}
