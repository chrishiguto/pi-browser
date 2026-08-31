import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeBrowserResult } from "../../src/browser.ts";

test("result normalization preserves page-derived content and metadata", () => {
  const result = normalizeBrowserResult("browser_snapshot", "session-1", {
    success: true,
    data: {
      snapshot: "button \"Submit\" [ref=e2]",
      url: "http://localhost:3000/#section",
      title: "Fixture",
    },
  });

  assert.equal(result.content[0].text, "button \"Submit\" [ref=e2]");
  assert.equal(result.details.operation, "browser_snapshot");
  assert.equal(result.details.session, "session-1");
  assert.equal(result.details.actor, "main");
  assert.equal(result.details.url, "http://localhost:3000/#section");
  assert.equal(result.details.title, "Fixture");
});

test("result normalization accepts upstream origin as current URL", () => {
  const result = normalizeBrowserResult("browser_act", "session-1", {
    success: true,
    data: { message: "ok", origin: "http://localhost:3000/done" },
  });

  assert.equal(result.details.url, "http://localhost:3000/done");
  assert.equal(result.content[0].text, "ok");
});

test("oversized text is bounded by the final guard", () => {
  const result = normalizeBrowserResult("browser_command", "session-1", { success: true }, {
    text: "x".repeat(100_000),
  });

  assert.equal(result.content[0].text.length, 60_000);
});

test("overrides supply text, artifact, and workflow flags", () => {
  const result = normalizeBrowserResult("browser_screenshot", "session-1", { success: true }, {
    actor: "main",
    text: "Screenshot captured: /tmp/pi-browser/1/shot.png",
    artifact: { kind: "screenshot", path: "/tmp/pi-browser/1/shot.png" },
    changedPage: false,
    snapshotIncluded: false,
  });

  assert.match(result.content[0].text, /Screenshot captured/);
  assert.deepEqual(result.details.artifact, { kind: "screenshot", path: "/tmp/pi-browser/1/shot.png" });
  assert.equal(result.details.changedPage, false);
  assert.equal(result.details.snapshotIncluded, false);
});
