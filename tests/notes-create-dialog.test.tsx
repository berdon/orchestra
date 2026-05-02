import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { NotesCreateDialog, buildCreateLocation, listDirectorySuggestions } from "../src/components/NotesCreateDialog";
import type { NotesRoot } from "../src/types";

const roots: NotesRoot[] = [
  {
    scope: "project",
    repositoryId: null,
    label: "Project",
    docsExists: true,
    children: [
      {
        kind: "directory",
        name: "guides",
        path: "guides",
        children: [
          {
            kind: "directory",
            name: "api",
            path: "guides/api",
            children: [],
          },
          {
            kind: "note",
            name: "intro.md",
            path: "guides/intro.md",
          },
        ],
      },
    ],
  },
];

describe("NotesCreateDialog", () => {
  test("renders destination fields and folder suggestions", () => {
    const markup = renderToString(
      <NotesCreateDialog
        mode="note"
        roots={roots}
        initialLocation={{ scope: "project", repositoryId: null, path: "guides" }}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('data-role="notes-create-dialog"');
    expect(markup).toContain('data-role="notes-create-root-select"');
    expect(markup).toContain('data-role="notes-create-folder-input"');
    expect(markup).toContain('data-role="notes-create-name-input"');
    expect(markup).toContain("guides/api");
    expect(markup).toContain("Project · docs/guides/new-note.md");
  });

  test("buildCreateLocation appends the markdown extension for notes", () => {
    expect(buildCreateLocation({ scope: "project", repositoryId: null }, "guides", "roadmap", "note")).toEqual({
      scope: "project",
      repositoryId: null,
      path: "guides/roadmap.md",
    });
  });

  test("listDirectorySuggestions flattens nested folders", () => {
    expect(listDirectorySuggestions(roots[0])).toEqual(["guides", "guides/api"]);
  });
});
