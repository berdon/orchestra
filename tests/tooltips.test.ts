import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPLANATORY_TOOLTIPS_ENABLED,
  ORCHESTRA_EXPLANATORY_TOOLTIPS_STORAGE_KEY,
  applyExplanatoryTooltips,
  getExplanatoryTooltipProps,
  loadStoredExplanatoryTooltips,
  storeExplanatoryTooltips,
} from "../src/lib/tooltips";

describe("tooltip helpers", () => {
  it("defaults to explanatory tooltips enabled when storage is empty", () => {
    const storage = {
      getItem: () => null,
    } satisfies Pick<Storage, "getItem">;

    expect(loadStoredExplanatoryTooltips(storage)).toBe(DEFAULT_EXPLANATORY_TOOLTIPS_ENABLED);
  });

  it("reads enabled and disabled tooltip preferences from storage", () => {
    expect(loadStoredExplanatoryTooltips({ getItem: () => "enabled" })).toBe(true);
    expect(loadStoredExplanatoryTooltips({ getItem: () => "disabled" })).toBe(false);
    expect(loadStoredExplanatoryTooltips({ getItem: () => "true" })).toBe(true);
    expect(loadStoredExplanatoryTooltips({ getItem: () => "false" })).toBe(false);
  });

  it("stores the tooltip preference", () => {
    const calls: Array<[string, string]> = [];
    const storage = {
      setItem: (key: string, value: string) => {
        calls.push([key, value]);
      },
    } satisfies Pick<Storage, "setItem">;

    storeExplanatoryTooltips(false, storage);
    storeExplanatoryTooltips(true, storage);

    expect(calls).toEqual([
      [ORCHESTRA_EXPLANATORY_TOOLTIPS_STORAGE_KEY, "disabled"],
      [ORCHESTRA_EXPLANATORY_TOOLTIPS_STORAGE_KEY, "enabled"],
    ]);
  });

  it("applies the tooltip preference to the document root and body", () => {
    const doc = {
      documentElement: {
        dataset: {},
      },
      body: {
        dataset: {},
      },
    } as unknown as Document;

    applyExplanatoryTooltips(false, doc);
    expect(doc.documentElement.dataset.explanatoryTooltips).toBe("disabled");
    expect(doc.body.dataset.explanatoryTooltips).toBe("disabled");

    applyExplanatoryTooltips(true, doc);
    expect(doc.documentElement.dataset.explanatoryTooltips).toBe("enabled");
    expect(doc.body.dataset.explanatoryTooltips).toBe("enabled");
  });

  it("only returns tooltip props when explanatory tooltips are enabled", () => {
    expect(getExplanatoryTooltipProps("Help text", true)).toEqual({
      title: "Help text",
      "data-tooltip": "Help text",
    });
    expect(getExplanatoryTooltipProps("Help text", false)).toEqual({});
    expect(getExplanatoryTooltipProps("   ", true)).toEqual({});
  });
});
