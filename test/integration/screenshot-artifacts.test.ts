import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentBrowserEngine } from "../../src/agent-browser.ts";
import { ArtifactStore } from "../../src/artifacts.ts";
import { BrowserController } from "../../src/browser.ts";
import { startFixture } from "../fixture/server.ts";
import { nodeExecutor } from "../helpers/node-executor.ts";

test("real browser captures unique owned PNG screenshots", { timeout: 60_000 }, async (t) => {
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-screenshot-test-"));
  const fixture = await startFixture();
  const artifacts = new ArtifactStore({ baseRoot });
  const engine = new AgentBrowserEngine(nodeExecutor, undefined, process.execPath, ["--no-sandbox"]);
  const browser = new BrowserController(engine, undefined, artifacts);
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => `screenshot-${process.pid}` },
  };
  t.after(async () => {
    await browser.close(undefined, ctx).catch(() => undefined);
    await artifacts.cleanup().catch(() => undefined);
    await fixture.close();
    await rm(baseRoot, { recursive: true, force: true });
  });

  await browser.open({ url: fixture.url }, undefined, ctx);
  const first = await browser.screenshot({ fullPage: true, annotate: true }, undefined, ctx);
  const second = await browser.screenshot({}, undefined, ctx);
  const firstPath = first.details.artifact?.path;
  const secondPath = second.details.artifact?.path;

  assert.ok(firstPath?.startsWith(`${artifacts.root}/`));
  assert.ok(secondPath?.startsWith(`${artifacts.root}/`));
  assert.notEqual(firstPath, secondPath);
  assert.equal((await stat(firstPath!)).isFile(), true);
  assert.deepEqual([...await readFile(firstPath!).then((bytes) => bytes.subarray(0, 8))], [137, 80, 78, 71, 13, 10, 26, 10]);
});
