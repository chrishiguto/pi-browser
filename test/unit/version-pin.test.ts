import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

import { AGENT_BROWSER_VERSION } from "../../src/agent-browser.ts";

interface PackageManifest {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

test("agent-browser is supplied externally without an npm runtime dependency", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;
  const manifestPin = manifest.dependencies?.["agent-browser"];

  assert.equal(manifestPin, undefined);
  assert.equal(AGENT_BROWSER_VERSION, "0.37.1");
  await assert.rejects(access(new URL("../../package-lock.json", import.meta.url)));
});

test("the normal test command retains every suite gate", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;

  const suiteCommands = new Set(manifest.scripts?.test?.split(/\s*&&\s*/u));
  for (const requiredSuite of ["pnpm run test:unit", "pnpm run test:integration", "pnpm run test:smoke"]) {
    assert.ok(suiteCommands.has(requiredSuite), `normal test command must include ${requiredSuite}`);
  }
});
