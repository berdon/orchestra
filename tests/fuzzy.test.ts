import { describe, expect, it } from "vitest";

import { fuzzySearch, fuzzyScore } from "../src/lib/fuzzy";

describe("fuzzy search", () => {
  it("prefers exact and prefix matches over looser subsequence matches", () => {
    const items = [
      { id: "1", label: "Tasks" },
      { id: "2", label: "Task board" },
      { id: "3", label: "Settings" },
    ];

    const matches = fuzzySearch("task", items, 3);
    expect(matches.map((match) => match.item.id)).toEqual(["1", "2"]);
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 0);
  });

  it("matches against keywords when the label alone would miss", () => {
    const score = fuzzyScore("ticket", {
      id: "create-task",
      label: "Create task",
      keywords: ["create ticket", "new issue"],
    });

    expect(score).toBeGreaterThan(0);
  });
});
