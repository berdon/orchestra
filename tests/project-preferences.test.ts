import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  private values = new Map<string, string>();

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.has(key) ? this.values.get(key)! : null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("projectPreferences.setStoredActiveProject", () => {
  beforeEach(async () => {
    const events = new EventTarget();
    const localStorage = new MemoryStorage();
    const windowMock = {
      localStorage,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    };
    Object.assign(globalThis, { window: windowMock });
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete globalThis.window;
    vi.resetModules();
  });

  it("emits orchestra:projects-changed when the active project changes", async () => {
    const { getStoredActiveProjectId, getStoredActiveProjectSlug, setStoredActiveProject } = await import("../src/lib/projectPreferences");
    const handler = vi.fn();
    window.addEventListener("orchestra:projects-changed", handler);

    setStoredActiveProject("project-1", "alpha");

    expect(getStoredActiveProjectId()).toBe("project-1");
    expect(getStoredActiveProjectSlug()).toBe("alpha");
    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener("orchestra:projects-changed", handler);
  });

  it("does not emit orchestra:projects-changed when setting the same project and slug again", async () => {
    const { setStoredActiveProject } = await import("../src/lib/projectPreferences");
    const handler = vi.fn();
    window.addEventListener("orchestra:projects-changed", handler);

    setStoredActiveProject("project-1", "alpha");
    setStoredActiveProject("project-1", "alpha");

    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener("orchestra:projects-changed", handler);
  });

  it("emits orchestra:projects-changed when the slug changes for the same project id", async () => {
    const { getStoredActiveProjectId, getStoredActiveProjectSlug, setStoredActiveProject } = await import("../src/lib/projectPreferences");
    const handler = vi.fn();
    window.addEventListener("orchestra:projects-changed", handler);

    setStoredActiveProject("project-1", "alpha");
    setStoredActiveProject("project-1", "beta");

    expect(getStoredActiveProjectId()).toBe("project-1");
    expect(getStoredActiveProjectSlug()).toBe("beta");
    expect(handler).toHaveBeenCalledTimes(2);

    window.removeEventListener("orchestra:projects-changed", handler);
  });
});
