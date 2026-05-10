import { describe, expect, test } from "vitest";

import { detectCodeLanguage, shouldSyntaxHighlightText } from "../src/lib/syntaxHighlighting";
import {
  getTaskAttachmentKind,
  getTaskAttachmentViewKind,
  isTaskAttachmentViewable,
} from "../src/lib/taskAttachments";

describe("task attachment view helpers", () => {
  test("treats common code and config files as viewable text even with generic media types", () => {
    expect(getTaskAttachmentViewKind("application/octet-stream", "server.ts")).toBe("text");
    expect(getTaskAttachmentViewKind("application/octet-stream", "Dockerfile")).toBe("text");
    expect(getTaskAttachmentViewKind("application/octet-stream", ".env")).toBe("text");
    expect(getTaskAttachmentKind("application/octet-stream", "config.yaml")).toBe("text");
    expect(isTaskAttachmentViewable("application/octet-stream", "settings.toml")).toBe(true);
  });

  test("keeps unsupported binary and archive files on the fallback path", () => {
    expect(getTaskAttachmentViewKind("application/zip", "bundle.zip")).toBeNull();
    expect(getTaskAttachmentKind("application/zip", "bundle.zip")).toBe("archive");
    expect(getTaskAttachmentKind("application/octet-stream", "blob.bin")).toBe("binary");
  });

  test("detects sensible syntax highlighting languages and size guards", () => {
    expect(detectCodeLanguage("Dockerfile", "application/octet-stream")).toBe("dockerfile");
    expect(detectCodeLanguage("notes.json", "application/octet-stream")).toBe("json");
    expect(detectCodeLanguage("schema.txt", "application/json")).toBe("json");
    expect(shouldSyntaxHighlightText(32 * 1024)).toBe(true);
    expect(shouldSyntaxHighlightText(512 * 1024)).toBe(false);
  });
});
