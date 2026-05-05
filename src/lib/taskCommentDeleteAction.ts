import type { OrchestraClientBootstrap } from "./orchestraClient/bootstrap";
import { isCapabilityAvailable } from "./orchestraClient/extensions";

export interface TaskCommentDeleteActionState {
  enabled: boolean;
  reason: string | null;
}

export function getTaskCommentDeleteActionState(bootstrap: OrchestraClientBootstrap): TaskCommentDeleteActionState {
  const deleteCapability = bootstrap.capabilities.tasks.commentDelete;
  if (!isCapabilityAvailable(deleteCapability)) {
    return {
      enabled: false,
      reason: deleteCapability.reason ?? "Deleting task comments is unavailable in this session.",
    };
  }

  const impactCapability = bootstrap.capabilities.tasks.commentDeleteImpact;
  if (!isCapabilityAvailable(impactCapability)) {
    return {
      enabled: false,
      reason: impactCapability.reason ?? "Comment delete impact inspection is unavailable in this session.",
    };
  }

  return {
    enabled: true,
    reason: null,
  };
}
