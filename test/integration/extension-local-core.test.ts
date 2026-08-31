import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBrowserExtension } from "../../extensions/browser/index.ts";
import type { PiExecutor } from "../../src/agent-browser.ts";
import { ArtifactStore } from "../../src/artifacts.ts";
import { startFixture } from "../fixture/server.ts";
import { nodeExecutor } from "../helpers/node-executor.ts";

const noSandboxExecutor: PiExecutor = (command, args, options) => {
  const launcher = args[0]?.endsWith("/agent-browser.js") ? args[0] : undefined;
  return launcher
    ? nodeExecutor(command, [launcher, "--args", "--no-sandbox", ...args.slice(1)], options)
    : nodeExecutor(command, ["--args", "--no-sandbox", ...args], options);
};

test("registered tools complete the real local core loop", { timeout: 60_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-extension-integration-"));
  t.after(() => rm(baseRoot, { recursive: true, force: true }));
  const artifacts = new ArtifactStore({ baseRoot });
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const handlers = new Map<string, (...args: any[]) => any>();
  let active = ["read", "other_extension"];
  const pi = {
    registerFlag: () => {},
    getFlag: () => false,
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool); },
    registerCommand: () => {},
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    appendEntry: () => {},
    exec: noSandboxExecutor,
  } as unknown as ExtensionAPI;
  createBrowserExtension({ artifacts })(pi);
  const ctx = {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => `extension-integration-${process.pid}`,
      getBranch: () => [],
    },
    ui: { notify: () => {} },
  };
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  assert.deepEqual(active.sort(), ["browser_enable", "other_extension", "read"]);

  await tools.get("browser_enable")!.execute("enable", {}, undefined, undefined, ctx);
  assert.ok(active.includes("browser_open"));
  assert.ok(active.includes("browser_run"));
  assert.ok(active.includes("browser_fill"));
  const help = await tools.get("browser_run")!.execute("help", {
    command: "get", args: ["--help"],
  }, undefined, undefined, ctx);
  assert.match(help.content[0].text, /Usage: agent-browser get/);
  const guidance = await tools.get("browser_run")!.execute("guidance", {
    command: "skills", args: ["get", "core"],
  }, undefined, undefined, ctx);
  assert.match(guidance.content[0].text, /Core agent-browser usage guide/);
  const opened = await tools.get("browser_open")!.execute("open", { url: fixture.url }, undefined, undefined, ctx);
  assert.equal(opened.details.title, "Pi Browser Fixture");
  assert.match(opened.content[0].text, /Email/);
  const snapshot = await tools.get("browser_run")!.execute("snapshot", {
    command: "snapshot", args: ["-i", "-c"],
  }, undefined, undefined, ctx);
  assert.match(snapshot.content[0].text, /Submit/);
  const title = await tools.get("browser_run")!.execute("title", {
    command: "get", args: ["title"],
  }, undefined, undefined, ctx);
  assert.match(title.content[0].text, /Pi Browser Fixture/);
  await tools.get("browser_fill")!.execute("fill", {
    target: "#email", value: "tool@example.test",
  }, undefined, undefined, ctx);
  const filled = await tools.get("browser_run")!.execute("verify", {
    command: "snapshot", args: ["-i", "-c"],
  }, undefined, undefined, ctx);
  assert.match(filled.content[0].text, /tool@example\.test/);
  await assert.rejects(
    tools.get("browser_open")!.execute("blocked", { url: "not a url" }, undefined, undefined, ctx),
    /^BrowserError: browser_invalid_input:/,
  );
  const closed = await tools.get("browser_close")!.execute("close", {}, undefined, undefined, ctx);
  const closedAgain = await tools.get("browser_close")!.execute("close-again", {}, undefined, undefined, ctx);
  assert.equal(closed.details.alreadyClosed, false);
  assert.equal(closedAgain.details.alreadyClosed, true);
  await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  await assert.rejects(stat(artifacts.root!), { code: "ENOENT" });
});
