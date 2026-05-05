import { describe, expect, it } from "vitest";

import { createOptimisticOrchestraClientBootstrap } from "../src/lib/orchestraClient/bootstrapFactory";
import { getTaskCommentDeleteActionState } from "../src/lib/taskCommentDeleteAction";

describe("getTaskCommentDeleteActionState", () => {
  it("enables delete when delete and impact capabilities are available", () => {
    const bootstrap = createOptimisticOrchestraClientBootstrap("mock");

    expect(getTaskCommentDeleteActionState(bootstrap)).toEqual({
      enabled: true,
      reason: null,
    });
  });

  it("surfaces the delete capability reason when deletion is unavailable", () => {
    const bootstrap = createOptimisticOrchestraClientBootstrap("mock");
    bootstrap.capabilities.tasks.commentDelete = {
      availability: "unavailable",
      reason: "Deleting comments requires tasks.comment.delete.",
    };

    expect(getTaskCommentDeleteActionState(bootstrap)).toEqual({
      enabled: false,
      reason: "Deleting comments requires tasks.comment.delete.",
    });
  });

  it("surfaces the delete-impact capability reason when the guarded path is unavailable", () => {
    const bootstrap = createOptimisticOrchestraClientBootstrap("mock");
    bootstrap.capabilities.tasks.commentDeleteImpact = {
      availability: "unavailable",
      reason: "Comment delete impact inspection is disabled.",
    };

    expect(getTaskCommentDeleteActionState(bootstrap)).toEqual({
      enabled: false,
      reason: "Comment delete impact inspection is disabled.",
    });
  });
});
