import { describe, expect, test } from "vitest";

import type { OrchestraClient, OrchestraClientBootstrap } from "../src/lib/orchestraClient";

export interface OrchestraClientContractHarness {
  client: OrchestraClient;
  expectedBootstrap: Pick<OrchestraClientBootstrap, "hostKind" | "authMode">;
  emitSharedEvents: () => Promise<void> | void;
  verifyTaskListDefaults?: () => Promise<void>;
  verifyCompletionOutcomes?: () => Promise<void>;
  verifySessionSubscriptionSemantics?: () => Promise<void>;
  verifyNormalizedFailureSemantics?: () => Promise<void>;
  dispose?: () => Promise<void> | void;
}

export function runOrchestraClientContractSuite(
  adapterName: string,
  createHarness: () => Promise<OrchestraClientContractHarness>,
) {
  describe(`${adapterName} orchestra client contract`, () => {
    test("resolves the expected shared bootstrap metadata", async () => {
      const harness = await createHarness();
      try {
        await expect(harness.client.getBootstrap()).resolves.toMatchObject({
          contractVersion: harness.client.contractVersion,
          hostKind: harness.expectedBootstrap.hostKind,
          authMode: harness.expectedBootstrap.authMode,
        });
      } finally {
        await harness.dispose?.();
      }
    });

    test("emits the shared discriminated event union", async () => {
      const harness = await createHarness();
      try {
        const received: string[] = [];
        const unsubscribe = await harness.client.events.subscribe((event) => {
          received.push(event.kind);
        });

        await harness.emitSharedEvents();

        expect(received).toEqual([
          "task.change",
          "session.change",
          "session.stream",
          "inbox.change",
        ]);

        unsubscribe();
      } finally {
        await harness.dispose?.();
      }
    });

    test("normalizes task-list defaults through the shared adapter surface", async () => {
      const harness = await createHarness();
      try {
        if (!harness.verifyTaskListDefaults) {
          expect(harness.verifyTaskListDefaults).toBeUndefined();
          return;
        }
        await harness.verifyTaskListDefaults();
      } finally {
        await harness.dispose?.();
      }
    });

    test("maps task completion outcomes through the shared adapter surface", async () => {
      const harness = await createHarness();
      try {
        if (!harness.verifyCompletionOutcomes) {
          expect(harness.verifyCompletionOutcomes).toBeUndefined();
          return;
        }
        await harness.verifyCompletionOutcomes();
      } finally {
        await harness.dispose?.();
      }
    });

    test("follows the shared session subscribe and unsubscribe contract", async () => {
      const harness = await createHarness();
      try {
        if (!harness.verifySessionSubscriptionSemantics) {
          expect(harness.verifySessionSubscriptionSemantics).toBeUndefined();
          return;
        }
        await harness.verifySessionSubscriptionSemantics();
      } finally {
        await harness.dispose?.();
      }
    });

    test("normalizes shared adapter failures when the adapter exposes normalized errors", async () => {
      const harness = await createHarness();
      try {
        if (!harness.verifyNormalizedFailureSemantics) {
          expect(harness.verifyNormalizedFailureSemantics).toBeUndefined();
          return;
        }
        await harness.verifyNormalizedFailureSemantics();
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
