import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBrowserExtension } from "../../extensions/browser/index.ts";
import { AgentBrowserEngine, type EngineJsonResult, type EngineRequest } from "../../src/agent-browser.ts";
import { ArtifactStore } from "../../src/artifacts.ts";
import type { BrowserEngine } from "../../src/browser.ts";
import { physicalSessionName } from "../../src/session.ts";
import { startFixture } from "../fixture/server.ts";
import { nodeExecutor } from "../helpers/node-executor.ts";

class RecordingEngine implements BrowserEngine {
  readonly closeSessions: string[] = [];

  constructor(private readonly inner: AgentBrowserEngine) {}

  run(request: EngineRequest, signal?: AbortSignal): Promise<EngineJsonResult> {
    return this.inner.run(request, signal);
  }

  async close(session: string, signal?: AbortSignal): Promise<void> {
    this.closeSessions.push(session);
    await this.inner.close(session, signal);
  }
}

function load(engine: BrowserEngine, artifacts: ArtifactStore, branch: unknown[]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const entries: unknown[] = [];
  let active = ["browser_enable"];
  const pi = {
    registerFlag: () => {},
    getFlag: () => false,
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool); },
    registerCommand: () => {},
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    exec: nodeExecutor,
  } as unknown as ExtensionAPI;
  createBrowserExtension({ engine, artifacts })(pi);
  const ctx = {
    cwd: process.cwd(),
    signal: undefined,
    sessionManager: {
      getSessionId: () => `real-reload-${process.pid}`,
      getBranch: () => [...branch, ...entries],
    },
    ui: { notify: () => {} },
  };
  return { handlers, tools, entries, ctx };
}

test("real daemon preserves page state across reload and closes on quit", { timeout: 60_000 }, async (t) => {
  const fixture = await startFixture();
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-real-reload-test-"));
  const engine = new RecordingEngine(new AgentBrowserEngine(nodeExecutor, undefined, process.execPath, ["--no-sandbox"]));
  const session = physicalSessionName(process.cwd(), `real-reload-${process.pid}`);
  t.after(async () => {
    await engine.close(session).catch(() => undefined);
    await fixture.close();
    await rm(baseRoot, { recursive: true, force: true });
  });
  const first = load(engine, new ArtifactStore({ baseRoot }), []);
  await first.handlers.get("session_start")!({ reason: "startup" }, first.ctx);
  await first.tools.get("browser_enable")!.execute("enable", {}, undefined, undefined, first.ctx);
  await first.tools.get("browser_open")!.execute("open", { url: fixture.url }, undefined, undefined, first.ctx);
  await first.tools.get("browser_fill")!.execute("fill", {
    target: "#email", value: "survives-reload@example.test",
  }, undefined, undefined, first.ctx);

  await first.handlers.get("session_shutdown")!({ reason: "reload" }, first.ctx);
  assert.equal(engine.closeSessions.length, 0);

  const replacement = load(engine, new ArtifactStore({ baseRoot }), first.entries);
  await replacement.handlers.get("session_start")!({ reason: "reload" }, replacement.ctx);
  const snapshot = await replacement.tools.get("browser_run")!.execute("snapshot", {
    command: "snapshot", args: ["-i", "-c"],
  }, undefined, undefined, replacement.ctx);
  assert.match(snapshot.content[0].text, /survives-reload@example\.test/);
  await replacement.handlers.get("session_shutdown")!({ reason: "quit" }, replacement.ctx);

  assert.equal(engine.closeSessions.length, 1);
});
