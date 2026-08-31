import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { AGENT_BROWSER_VERSION } from "../../src/agent-browser.ts";

interface PackageManifest {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<string, {
    dependencies?: Record<string, string>;
    version?: string;
    resolved?: string;
  }>;
}

test("agent-browser is exactly pinned in the manifest and lockfile", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;
  const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8")) as PackageLock;
  const manifestPin = manifest.dependencies?.["agent-browser"];

  assert.equal(manifestPin, "0.35.1");
  assert.equal(AGENT_BROWSER_VERSION, manifestPin);
  assert.equal(lock.packages?.[""]?.dependencies?.["agent-browser"], manifestPin);
  assert.equal(lock.packages?.["node_modules/agent-browser"]?.version, manifestPin);
  const escapedPin = manifestPin!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(lock.packages?.["node_modules/agent-browser"]?.resolved ?? "", new RegExp(`agent-browser-${escapedPin}\\.tgz$`));
});

test("the normal test command retains every suite gate", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;

  const suiteCommands = new Set(manifest.scripts?.test?.split(/\s*&&\s*/u));
  for (const requiredSuite of ["npm run test:unit", "npm run test:integration", "npm run test:smoke"]) {
    assert.ok(suiteCommands.has(requiredSuite), `normal test command must include ${requiredSuite}`);
  }
});
