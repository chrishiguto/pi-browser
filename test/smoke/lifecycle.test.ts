import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBrowserExtension } from "../../extensions/browser/index.ts";
import type { EngineJsonResult, EngineRequest } from "../../src/agent-browser.ts";
import { ArtifactStore } from "../../src/artifacts.ts";
import type { BrowserEngine } from "../../src/browser.ts";

class LifecycleEngine implements BrowserEngine {
  readonly requests: EngineRequest[] = [];
  readonly closeSessions: string[] = [];

  async run(request: EngineRequest): Promise<EngineJsonResult> {
    this.requests.push(request);
    if (request.command === "open") return { success: true, data: { url: request.args[0], title: "Fixture" } };
    return { success: true, data: { snapshot: "button Continue [ref=e1]", url: "http://localhost/" } };
  }

  async close(session: string): Promise<void> {
    this.closeSessions.push(session);
  }
}

function load(engine: BrowserEngine, artifacts: ArtifactStore, branch: unknown[] = [], shutdownTimeoutMs?: number) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  const notices: string[] = [];
  let active = ["browser_enable"];
  const pi = {
    registerFlag: () => {},
    getFlag: () => false,
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    exec: async () => { throw new Error("injected lifecycle engine should be used"); },
  } as unknown as ExtensionAPI;
  createBrowserExtension({ artifacts, engine, ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }) })(pi);
  const ctx = {
    cwd: `/project-${Date.now()}-${Math.random()}`,
    signal: undefined,
    sessionManager: { getSessionId: () => "lifecycle-session", getBranch: () => [...branch, ...entries] },
    ui: { notify: (message: string) => notices.push(message) },
  };
  return { handlers, tools, commands, entries, notices, ctx };
}

test("reload hands off the open deterministic session and quit closes it once", async (t) => {
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-reload-test-"));
  t.after(() => rm(baseRoot, { recursive: true, force: true }));
  const engine = new LifecycleEngine();
  const first = load(engine, new ArtifactStore({ baseRoot }));
  await first.handlers.get("session_start")!({ reason: "startup" }, first.ctx);
  await first.tools.get("browser_enable")!.execute("enable", {}, undefined, undefined, first.ctx);
  await first.tools.get("browser_open")!.execute("open", { url: "http://localhost/" }, undefined, undefined, first.ctx);
  const originalSession = engine.requests[0].session;

  await first.handlers.get("session_shutdown")!({ reason: "reload" }, first.ctx);
  assert.equal(engine.closeSessions.length, 0);
  await assert.rejects(
    first.tools.get("browser_run")!.execute("old-runtime", { command: "snapshot", args: ["-i", "-c"] }, undefined, undefined, first.ctx),
    /^BrowserError: browser_cancelled:/,
  );

  const replacement = load(engine, new ArtifactStore({ baseRoot }), first.entries);
  replacement.ctx.cwd = first.ctx.cwd;
  await replacement.handlers.get("session_start")!({ reason: "reload" }, replacement.ctx);
  await replacement.tools.get("browser_run")!.execute("snapshot", { command: "snapshot", args: ["-i", "-c"] }, undefined, undefined, replacement.ctx);
  assert.equal(engine.requests.at(-1)?.session, originalSession);
  await replacement.handlers.get("session_shutdown")!({ reason: "quit" }, replacement.ctx);
  await replacement.handlers.get("session_shutdown")!({ reason: "quit" }, replacement.ctx);
  assert.deepEqual(engine.closeSessions, [originalSession]);
});

test("new, resume, fork, and quit each close an owned browser exactly once", async (t) => {
  for (const reason of ["new", "resume", "fork", "quit"] as const) {
    const baseRoot = await mkdtemp(join(tmpdir(), `pi-browser-${reason}-test-`));
    t.after(() => rm(baseRoot, { recursive: true, force: true }));
    const engine = new LifecycleEngine();
    const runtime = load(engine, new ArtifactStore({ baseRoot }));
    runtime.ctx.sessionManager.getSessionId = () => `${reason}-session`;
    await runtime.handlers.get("session_start")!({ reason: "startup" }, runtime.ctx);
    await runtime.tools.get("browser_enable")!.execute("enable", {}, undefined, undefined, runtime.ctx);
    await runtime.tools.get("browser_open")!.execute("open", { url: "http://localhost/" }, undefined, undefined, runtime.ctx);

    await runtime.handlers.get("session_shutdown")!({ reason }, runtime.ctx);
    await runtime.handlers.get("session_shutdown")!({ reason }, runtime.ctx);

    assert.equal(engine.closeSessions.length, 1, reason);
  }
});

test("headed preference persists on the branch and a mode change waits for explicit open", async (t) => {
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-headed-test-"));
  t.after(() => rm(baseRoot, { recursive: true, force: true }));
  const engine = new LifecycleEngine();
  const runtime = load(engine, new ArtifactStore({ baseRoot }));
  await runtime.handlers.get("session_start")!({ reason: "startup" }, runtime.ctx);
  await runtime.commands.get("browser")!.handler("headed on", runtime.ctx);
  await runtime.tools.get("browser_open")!.execute("open", { url: "http://localhost/" }, undefined, undefined, runtime.ctx);
  assert.equal(engine.requests.find((request) => request.command === "open")?.headed, true);

  const closesBeforePreferenceChange = engine.closeSessions.length;
  await runtime.commands.get("browser")!.handler("headed off", runtime.ctx);
  assert.equal(engine.closeSessions.length, closesBeforePreferenceChange);
  assert.match(runtime.notices.at(-1) ?? "", /next browser_open.*fresh launch|fresh launch.*next browser_open/i);
  await runtime.tools.get("browser_open")!.execute("open", { url: "http://localhost/" }, undefined, undefined, runtime.ctx);
  assert.equal(engine.closeSessions.length, closesBeforePreferenceChange + 1);
  assert.equal(engine.requests.filter((request) => request.command === "open").at(-1)?.headed, false);

  await runtime.handlers.get("session_shutdown")!({ reason: "reload" }, runtime.ctx);
  const replacement = load(engine, new ArtifactStore({ baseRoot }), runtime.entries, 20);
  replacement.ctx.cwd = runtime.ctx.cwd;
  await replacement.handlers.get("session_start")!({ reason: "reload" }, replacement.ctx);
  await replacement.commands.get("browser")!.handler("headed", replacement.ctx);
  assert.match(replacement.notices.at(-1) ?? "", /headed preference: off/i);
  await replacement.handlers.get("session_shutdown")!({ reason: "quit" }, replacement.ctx);

  const freshSession = load(new LifecycleEngine(), new ArtifactStore({ baseRoot: `${baseRoot}-new` }));
  await freshSession.handlers.get("session_start")!({ reason: "new" }, freshSession.ctx);
  await freshSession.commands.get("browser")!.handler("headed", freshSession.ctx);
  assert.match(freshSession.notices.at(-1) ?? "", /headed preference: off/i);
});

test("terminal shutdown is bounded and preserves artifacts when close fails", async (t) => {
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-bounded-shutdown-test-"));
  t.after(() => rm(baseRoot, { recursive: true, force: true }));
  class StuckCloseEngine extends LifecycleEngine {
    override async close(session: string, signal?: AbortSignal): Promise<void> {
      this.closeSessions.push(session);
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("close aborted")), { once: true });
      });
    }
  }
  const engine = new StuckCloseEngine();
  const artifacts = new ArtifactStore({ baseRoot, pid: 100 });
  const runtime = load(engine, artifacts, [], 20);
  await runtime.handlers.get("session_start")!({ reason: "startup" }, runtime.ctx);
  await runtime.tools.get("browser_enable")!.execute("enable", {}, undefined, undefined, runtime.ctx);
  await runtime.tools.get("browser_open")!.execute("open", { url: "http://localhost/" }, undefined, undefined, runtime.ctx);
  const artifact = await artifacts.allocate(".txt");
  await writeFile(artifact, "owned");

  const started = Date.now();
  await runtime.handlers.get("session_shutdown")!({ reason: "quit" }, runtime.ctx);

  assert.ok(Date.now() - started < 1_000);
  assert.equal(await stat(artifact).then(() => true), true);
  assert.match(runtime.notices.at(-1) ?? "", /cleanup failed/i);
});

test("reload shutdown returns immediately even with an operation in flight", async (t) => {
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-bounded-reload-test-"));
  t.after(() => rm(baseRoot, { recursive: true, force: true }));
  class StuckOperationEngine extends LifecycleEngine {
    stuck = false;

    override async run(request: EngineRequest): Promise<EngineJsonResult> {
      if (this.stuck && request.command === "snapshot") return new Promise<EngineJsonResult>(() => {});
      return super.run(request);
    }
  }
  const engine = new StuckOperationEngine();
  const runtime = load(engine, new ArtifactStore({ baseRoot }), [], 20);
  await runtime.handlers.get("session_start")!({ reason: "startup" }, runtime.ctx);
  await runtime.tools.get("browser_enable")!.execute("enable", {}, undefined, undefined, runtime.ctx);
  await runtime.tools.get("browser_open")!.execute("open", { url: "http://localhost/" }, undefined, undefined, runtime.ctx);
  engine.stuck = true;
  void runtime.tools.get("browser_run")!.execute("stuck", { command: "snapshot", args: ["-i", "-c"] }, undefined, undefined, runtime.ctx).catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));

  const started = Date.now();
  await runtime.handlers.get("session_shutdown")!({ reason: "reload" }, runtime.ctx);

  assert.ok(Date.now() - started < 1_000);
  assert.equal(engine.closeSessions.length, 0);
  const replacement = load(engine, new ArtifactStore({ baseRoot }), runtime.entries, 20);
  replacement.ctx.cwd = runtime.ctx.cwd;
  await replacement.handlers.get("session_start")!({ reason: "reload" }, replacement.ctx);
  await replacement.handlers.get("session_shutdown")!({ reason: "quit" }, replacement.ctx);
});
