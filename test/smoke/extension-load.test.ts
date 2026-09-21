import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { createBrowserExtension } from "../../extensions/browser/index.ts";
import { ArtifactStore } from "../../src/artifacts.ts";
import { withCompatibleCli } from "../helpers/compatible-exec.ts";

const normalFlagApi = {
  registerFlag: () => {},
  getFlag: () => false,
};

test("factory registers tools and toggles them without side effects", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const handlers = new Map<string, (...args: any[]) => any>();
  let active = ["read", "other_extension"];
  let executions = 0;
  const pi = {
    ...normalFlagApi,
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command);
    },
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    appendEntry: () => {},
    exec: async () => {
      executions += 1;
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI;

  extension(pi);

  assert.deepEqual([...commands.keys()], ["browser"]);
  assert.deepEqual([...tools.keys()].sort(), [
    "browser_close", "browser_enable", "browser_fill", "browser_open", "browser_run", "browser_screenshot",
  ]);
  assert.equal(executions, 0);

  await handlers.get("session_start")?.({ reason: "startup" }, {
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
  });
  assert.deepEqual(active.sort(), ["browser_enable", "other_extension", "read"]);
  const resources = await handlers.get("resources_discover")?.({ reason: "startup" }, {});
  assert.deepEqual(resources?.skillPaths, [join(process.cwd(), "skills")]);

  const ctx = {
    cwd: "/project",
    signal: undefined,
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    ui: { notify: () => {} },
  };
  const enabled = await tools.get("browser_enable")!.execute("call", {}, undefined, undefined, ctx);
  assert.match(enabled.content[0].text, /browser_open/);
  assert.deepEqual(active.sort(), [
    "browser_close", "browser_enable", "browser_fill", "browser_open", "browser_run", "browser_screenshot", "other_extension", "read",
  ]);

  await commands.get("browser")!.handler("off", ctx);
  assert.deepEqual(active.sort(), ["browser_enable", "other_extension", "read"]);
  assert.equal(executions, 0);
});
function statusHarness(exec: (command: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean }>) {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const notices: Array<{ message: string; level: string }> = [];
  const pi = {
    ...normalFlagApi,
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command);
    },
    registerTool: () => {},
    on: () => {},
    getActiveTools: () => ["read"],
    setActiveTools: () => {},
    appendEntry: () => {},
    exec,
  } as unknown as ExtensionAPI;
  extension(pi);
  const status = () => commands.get("browser")!.handler("status", {
    signal: undefined,
    cwd: "/project",
    sessionManager: { getSessionId: () => "session" },
    ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
  });
  return { commands, notices, status };
}

test("status reports cli compatibility without claiming browser readiness", async () => {
  const harness = statusHarness(async (_command, args) => args.at(-1) === "--version"
    ? { code: 0, stdout: "0.37.1\n", stderr: "", killed: false }
    : Promise.reject(new Error("status must not launch or inspect a browser")));

  await harness.status();

  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].level, "info");
  const message = harness.notices[0].message;
  assert.match(message, /cli: 0\.37\.1/);
  assert.match(message, /supported cli: 0\.37\.1/);
  assert.match(message, /browser: closed/);
  assert.match(message, /executable: agent-browser$/m);
  assert.match(message, /tools: disabled/);
  assert.match(message, /session: pi-browser-/);
  assert.match(message, /headed preference: off/);
  assert.match(message, /running mode: closed/);
  assert.match(message, /artifact root: .*pi-browser/);
});

test("status makes an incompatible cli actionable", async () => {
  const harness = statusHarness(async (_command, args) => args.at(-1) === "--version"
    ? { code: 0, stdout: "agent-browser 0.34.0\n", stderr: "", killed: false }
    : Promise.reject(new Error("status must not launch or inspect a browser")));

  await harness.status();

  assert.match(harness.notices[0].message, /agent-browser 0\.34\.0 is incompatible; expected 0\.37\.1/);
});

test("status retains owned state when cli diagnostics fail", async () => {
  const harness = statusHarness(async () => ({ code: 1, stdout: "", stderr: "missing launcher", killed: false }));

  await harness.status();

  assert.equal(harness.notices[0].level, "warning");
  const message = harness.notices[0].message;
  assert.match(message, /tools: disabled/);
  assert.match(message, /session: pi-browser-/);
  assert.match(message, /headed preference: off/);
  assert.match(message, /running mode: closed/);
  assert.match(message, /artifact root: .*pi-browser/);
  assert.match(message, /supported cli: 0\.37\.1/);
  assert.match(message, /diagnostics failed: .*missing launcher/);
  assert.match(message, /run chezmoi apply.*retry \/browser status/i);
});

test("removed install command does not execute a package manager", async () => {
  let calls = 0;
  const harness = statusHarness(async () => { calls++; throw new Error("must not execute"); });
  await harness.commands.get("browser")!.handler("install", {
    ui: { notify: (message: string, level: string) => harness.notices.push({ message, level }) },
  });
  assert.equal(calls, 0);
  assert.match(harness.notices[0].message, /Usage:/);
  assert.doesNotMatch(harness.notices[0].message, /browser install/);
});

test("off disables tools even when an owned browser close fails", async (t) => {
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-off-failure-test-"));
  t.after(() => rm(baseRoot, { recursive: true, force: true }));
  const artifacts = new ArtifactStore({ baseRoot });
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const notices: Array<{ message: string; level: string }> = [];
  let active = ["browser_enable"];
  const pi = {
    ...normalFlagApi,
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command);
    },
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    appendEntry: () => {},
    exec: withCompatibleCli(async (_command, args) => {
      const action = args.find((arg) => ["open", "snapshot", "close"].includes(arg));
      if (action === "close") return { code: 1, stdout: "", stderr: "close failed", killed: false };
      if (action === "open") {
        return { code: 0, stdout: JSON.stringify({ success: true, data: { url: "http://localhost/", title: "Fixture" } }), stderr: "", killed: false };
      }
      return { code: 0, stdout: JSON.stringify({ success: true, data: { snapshot: "heading Fixture" } }), stderr: "", killed: false };
    }),
  } as unknown as ExtensionAPI;
  createBrowserExtension({ artifacts })(pi);
  const ctx = {
    signal: undefined,
    cwd: "/project",
    sessionManager: { getSessionId: () => "session" },
    ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
  };
  await tools.get("browser_enable")!.execute("enable", {}, undefined, undefined, ctx);
  await tools.get("browser_open")!.execute("open", { url: "http://localhost/" }, undefined, undefined, ctx);

  await commands.get("browser")!.handler("off", ctx);

  assert.deepEqual(active, ["browser_enable"]);
  assert.equal(notices.at(-1)?.level, "warning");
  assert.match(notices.at(-1)?.message ?? "", /tools disabled.*close failed/i);
  await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  assert.match(notices.at(-1)?.message ?? "", /cleanup failed during quit/i);
});

test("reload preserves owned artifacts and terminal shutdown removes them", async (t) => {
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-lifecycle-test-"));
  t.after(() => rm(baseRoot, { recursive: true, force: true }));
  const ctx = {
    cwd: "/project",
    sessionManager: { getSessionId: () => "artifact-session", getBranch: () => [] },
    ui: { notify: () => {} },
  };
  const load = (artifacts: ArtifactStore) => {
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    const handlers = new Map<string, (...args: any[]) => any>();
    let active = ["browser_enable", "read"];
    const pi = {
      ...normalFlagApi,
      registerCommand: () => {},
      registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool); },
      on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { active = [...names]; },
      appendEntry: () => {},
      exec: withCompatibleCli(async (_command, args) => {
        const action = args.find((arg) => ["open", "snapshot", "screenshot", "close"].includes(arg));
        if (action === "open") return { code: 0, stdout: JSON.stringify({ success: true, data: { url: "http://localhost/" } }), stderr: "", killed: false };
        if (action === "snapshot") return { code: 0, stdout: JSON.stringify({ success: true, data: { snapshot: "heading Fixture" } }), stderr: "", killed: false };
        if (action === "screenshot") {
          await writeFile(args.at(-1)!, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          return { code: 0, stdout: JSON.stringify({ success: true, data: {} }), stderr: "", killed: false };
        }
        return { code: 0, stdout: JSON.stringify({ success: true, data: {} }), stderr: "", killed: false };
      }),
    } as unknown as ExtensionAPI;
    createBrowserExtension({ artifacts })(pi);
    return { tools, handlers };
  };

  const firstArtifacts = new ArtifactStore({ baseRoot });
  const first = load(firstArtifacts);
  await first.handlers.get("session_start")?.({ reason: "startup" }, ctx);
  await first.tools.get("browser_enable")!.execute("enable", {}, undefined, undefined, ctx);
  await first.tools.get("browser_open")!.execute("open", { url: "http://localhost/" }, undefined, undefined, ctx);
  const captured = await first.tools.get("browser_screenshot")!.execute("capture", {}, undefined, undefined, ctx);
  const path = captured.details.artifact.path as string;
  const outputPath = await firstArtifacts.allocate(".txt");
  await writeFile(outputPath, "owned output");
  await first.handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  await stat(path);
  await stat(outputPath);

  const replacementArtifacts = new ArtifactStore({ baseRoot });
  const replacement = load(replacementArtifacts);
  await replacement.handlers.get("session_start")?.({ reason: "reload" }, ctx);
  await stat(path);
  await stat(outputPath);
  await replacement.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  await assert.rejects(stat(path), { code: "ENOENT" });
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
});
