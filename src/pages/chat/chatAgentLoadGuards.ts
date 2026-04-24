import type { PrimaryPage } from "../../types";

export function shouldApplyChatAgentLoad(
  activePage: PrimaryPage,
  requestProjectId: string | null,
  currentProjectId: string | null,
  requestId: number,
  latestRequestId: number,
) {
  return activePage === "chat" && requestProjectId === currentProjectId && requestId === latestRequestId;
}
