import assert from "node:assert/strict";
import { test } from "node:test";

import { BrowserState } from "../../src/state.ts";

function fakePi(active: string[]) {
  const entries: Array<{ customType: string; data: unknown }> = [];
  return {
    entries,
    getActiveTools: () => [...active],
    setActiveTools: (next: string[]) => {
      active = [...next];
    },
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
  };
}

test("activation changes only owned tools and records branch state", () => {
  const pi = fakePi(["read", "other_extension", "browser_run"]);
  const state = new BrowserState();

  state.setEnabled(pi, true);
  assert.deepEqual(pi.getActiveTools().sort(), [
    "browser_close", "browser_enable", "browser_fill", "browser_open", "browser_run", "browser_screenshot", "other_extension", "read",
  ]);
  assert.deepEqual(pi.entries.at(-1)?.data, { version: 1, enabled: true, headed: false });

  state.setHeaded(pi, true);
  assert.equal(state.headed, true);
  assert.deepEqual(pi.entries.at(-1)?.data, { version: 1, enabled: true, headed: true });

  state.setEnabled(pi, false);
  assert.deepEqual(pi.getActiveTools().sort(), ["browser_enable", "other_extension", "read"]);
  assert.deepEqual(pi.entries.at(-1)?.data, { version: 1, enabled: false, headed: true });
});

test("state restores the last valid entry on the active branch", () => {
  const state = new BrowserState();
  state.restore([
    { type: "custom", customType: "pi-browser-state", data: { version: 1, enabled: true } },
    { type: "custom", customType: "unrelated", data: { enabled: false } },
    { type: "custom", customType: "pi-browser-state", data: { version: 1, enabled: false, headed: true } },
  ]);
  assert.equal(state.enabled, false);
  assert.equal(state.headed, true);

  state.restore([{ type: "custom", customType: "pi-browser-state", data: { version: 1, enabled: true } }]);
  assert.equal(state.enabled, true);
  assert.equal(state.headed, false);
});
