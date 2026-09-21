import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentBrowserEngine } from "../../src/agent-browser.ts";
import { BrowserController } from "../../src/browser.ts";
import { startFixture } from "../fixture/server.ts";
import { nodeExecutor } from "../helpers/node-executor.ts";

test("real shared browser opens, snapshots, contains, and closes", { timeout: 60_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const engine = new AgentBrowserEngine(nodeExecutor, undefined, ["--no-sandbox"]);
  const browser = new BrowserController(engine);
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => `integration-${process.pid}` },
  };
  t.after(async () => {
    await browser.close(undefined, ctx).catch(() => undefined);
  });

  const opened = await browser.open({ url: fixture.url }, undefined, ctx);
  assert.equal(opened.details.title, "Pi Browser Fixture");
  assert.equal(opened.details.url, fixture.url);
  assert.match(opened.content[0].text, /Email/);
  assert.match(opened.content[0].text, /ref=e\d+/);

  const snapshot = await browser.command({ command: "snapshot", args: ["-i", "-c"] }, undefined, ctx);
  assert.match(snapshot.content[0].text, /Submit/);
  assert.ok(Buffer.byteLength(snapshot.content[0].text) <= 60_000);

  await assert.rejects(browser.open({ url: "not a url" }, undefined, ctx), /^BrowserError: browser_invalid_input:/);
  const preserved = await browser.command({ command: "snapshot", args: ["-i", "-c"] }, undefined, ctx);
  assert.match(preserved.content[0].text, /Email/);

  const closed = await browser.close(undefined, ctx);
  const closedAgain = await browser.close(undefined, ctx);
  assert.equal(closed.details.alreadyClosed, false);
  assert.equal(closedAgain.details.alreadyClosed, true);
  assert.ok(fixture.requests.length >= 1);
  assert.ok(fixture.requests.every((request) => request.startsWith("/")));
});
