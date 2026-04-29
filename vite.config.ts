import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const VITEST_COVERAGE_INCLUDE = [
  "src/lib/access.ts",
  "src/lib/commandPalette.ts",
  "src/lib/defaultInstallBaseline.ts",
  "src/lib/orchestraPaths.ts",
  "src/lib/referenceMentions.ts",
  "src/lib/sessionListMerge.ts",
  "src/lib/taskTags.ts",
  "src/lib/taskUnreadCommentVisibility.ts",
  "src/lib/theme.ts",
  "src/pages/tasks/taskDetailLoadGuards.ts",
  "src/pages/tasks/taskOverviewState.ts",
];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: VITEST_COVERAGE_INCLUDE,
      reporter: ["text", "html", "json-summary", "lcov"],
      reportsDirectory: "coverage/vitest",
      thresholds: {
        statements: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
