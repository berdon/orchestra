import { describe, expect, it } from "vitest";

import {
  TASK_TAG_COUNT_ERROR,
  TASK_TAG_LENGTH_ERROR,
  TASK_TAG_SYNTAX_ERROR,
  commitTaskTagCandidates,
  normalizeTaskTags,
  splitTaskTagPaste,
  validateTaskTagSet,
} from "../src/lib/taskTags";

describe("taskTags", () => {
  it("normalizes tags to lower-case sorted unique values", () => {
    expect(normalizeTaskTags([" Backend ", "api", "backend", "UI"]))
      .toEqual(["api", "backend", "ui"]);
  });

  it("rejects invalid syntax and overlong tags", () => {
    expect(validateTaskTagSet(["has space"])).toBe(TASK_TAG_SYNTAX_ERROR);
    expect(validateTaskTagSet(["a".repeat(33)])).toBe(TASK_TAG_LENGTH_ERROR);
  });

  it("enforces the maximum unique tag count after normalization", () => {
    expect(validateTaskTagSet(Array.from({ length: 21 }, (_, index) => `tag-${index + 1}`))).toBe(TASK_TAG_COUNT_ERROR);
    expect(validateTaskTagSet([...Array.from({ length: 19 }, (_, index) => `tag-${index + 1}`), "Tag-1", "tag-2"])).toBeNull();
  });

  it("commits candidate tags with duplicate collapse and lexicographic sorting", () => {
    expect(commitTaskTagCandidates(["backend"], ["Backend", "api"]))
      .toEqual({ ok: true, tags: ["api", "backend"], added: ["api"] });
  });

  it("rejects paste batches when any nonblank candidate is invalid", () => {
    expect(splitTaskTagPaste("frontend,\nbackend\r\nops")).toEqual(["frontend", "backend", "ops"]);
    expect(commitTaskTagCandidates(["backend"], splitTaskTagPaste("frontend,has space"))).toEqual({ ok: false, error: TASK_TAG_SYNTAX_ERROR });
  });

  it("accepts paste batches when normalization keeps them within the count limit", () => {
    const existing = Array.from({ length: 18 }, (_, index) => `tag-${index + 1}`);
    expect(commitTaskTagCandidates(existing, splitTaskTagPaste("tag-1,tag-19,Tag-20")))
      .toEqual({
        ok: true,
        tags: [...existing, "tag-19", "tag-20"].sort((left, right) => left.localeCompare(right)),
        added: ["tag-19", "tag-20"],
      });
  });
});
