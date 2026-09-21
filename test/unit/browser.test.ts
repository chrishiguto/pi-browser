import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentBrowserEngine } from "../../src/agent-browser.ts";
import { BrowserController, BrowserProfiles, type BrowserEngine } from "../../src/browser.ts";
import { browserError } from "../../src/errors.ts";
import type { EngineRequest, EngineJsonResult } from "../../src/agent-browser.ts";
import { withCompatibleCli } from "../helpers/compatible-exec.ts";

const ctx = {
  cwd: "/project",
  sessionManager: { getSessionId: () => "pi-session" },
};

const snapshotCommand = { command: "snapshot", args: ["-i", "-c"] };

class FakeEngine implements BrowserEngine {
  readonly requests: EngineRequest[] = [];
  closeCalls = 0;
  snapshotData: Record<string, unknown> = {
    snapshot: "textbox \"Email\" [ref=e1]\nbutton \"Submit\" [ref=e2]",
  };

  async run(request: EngineRequest): Promise<EngineJsonResult> {
    this.requests.push(request);
    if (request.command === "open") {
      return { success: true, data: { url: request.args[0], title: "Fixture" } };
    }
    return { success: true, data: this.snapshotData };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

test("controller performs open, generic snapshot, and idempotent close", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);

  const opened = await browser.open({ url: "http://127.0.0.1:3000/form" }, undefined, ctx);
  assert.match(opened.content[0].text, /Email/);
  assert.equal(opened.details.url, "http://127.0.0.1:3000/form");
  assert.equal(opened.details.title, "Fixture");
  assert.deepEqual(engine.requests.map((request) => request.command), ["open", "snapshot"]);
  assert.equal(engine.requests[0]?.timeoutClass, "navigation");
  assert.equal(engine.requests[1]?.timeoutClass, undefined);
  assert.deepEqual(engine.requests[1].args, ["-i", "-c"]);

  const snapshot = await browser.command({ command: "snapshot", args: ["-i", "-c", "-u", "-d", "4"] }, undefined, ctx);
  assert.match(snapshot.content[0].text, /Submit/);
  assert.deepEqual(engine.requests.at(-1)?.args, ["-i", "-c", "-u", "-d", "4"]);

  const closed = await browser.close(undefined, ctx);
  const closedAgain = await browser.close(undefined, ctx);
  assert.equal(engine.closeCalls, 1);
  assert.equal(closed.details.alreadyClosed, false);
  assert.equal(closedAgain.details.alreadyClosed, true);
});

test("controller opens external URLs without gating", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);

  const opened = await browser.open({ url: "https://google.com/search?q=pi" }, undefined, ctx);

  assert.equal(opened.details.url, "https://google.com/search?q=pi");
  assert.deepEqual(engine.requests.map((request) => request.command), ["open", "snapshot"]);
});

test("controller rejects an invalid URL before engine invocation", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);

  await assert.rejects(browser.open({ url: "not a url" }, undefined, ctx), /^BrowserError: browser_invalid_input:/);
  assert.equal(engine.requests.length, 0);
});

test("open passes a named persistent profile through to the engine", async (t) => {
  const profileRoot = await mkdtemp(join(tmpdir(), "pi-browser-profile-test-"));
  t.after(() => rm(profileRoot, { recursive: true, force: true }));
  const engine = new FakeEngine();
  const browser = new BrowserController(engine, undefined, undefined, new BrowserProfiles(profileRoot));

  await browser.open({ url: "https://staging.example", profile: "staging" }, undefined, ctx);

  assert.equal(engine.requests[0]?.profile, join(profileRoot, "staging"));
  assert.equal(engine.requests[1]?.profile, join(profileRoot, "staging"));
  assert.ok((await stat(join(profileRoot, "staging"))).isDirectory());
  assert.equal(browser.status(ctx).profile, "staging");

  await assert.rejects(
    browser.open({ url: "https://staging.example", profile: "Bad/Name" }, undefined, ctx),
    /^BrowserError: browser_invalid_input:/,
  );
});

test("changing headed or profile relaunches the browser", async (t) => {
  const profileRoot = await mkdtemp(join(tmpdir(), "pi-browser-profile-test-"));
  t.after(() => rm(profileRoot, { recursive: true, force: true }));
  const engine = new FakeEngine();
  const browser = new BrowserController(engine, undefined, undefined, new BrowserProfiles(profileRoot));
  await browser.open({ url: "https://example.com" }, undefined, ctx);

  const relaunched = await browser.open({ url: "https://example.com", profile: "staging" }, undefined, ctx);

  assert.equal(engine.closeCalls, 1);
  assert.match(relaunched.content[0].text, /relaunched/);

  await browser.open({ url: "https://example.com", profile: "staging" }, undefined, ctx);
  assert.equal(engine.closeCalls, 1);
});

test("a snapshot without a prior open still reaches the engine and is covered by cleanup", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);

  const result = await browser.command(snapshotCommand, undefined, ctx);

  assert.match(result.content[0].text, /Email/);
  await browser.closeAll();
  assert.equal(engine.closeCalls, 1);
});

test("wait and navigation commands receive their timeout classes", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  engine.requests.length = 0;

  await browser.command({ command: "wait", args: ["1"] }, undefined, ctx);
  await browser.command({ command: "navigate", args: ["http://localhost:3000/next"] }, undefined, ctx);
  await browser.command({ command: "click", args: ["@e2"] }, undefined, ctx);

  assert.equal(engine.requests[0]?.timeoutClass, "wait");
  assert.equal(engine.requests[1]?.timeoutClass, "navigation");
  assert.equal(engine.requests[2]?.timeoutClass, undefined);
});

test("generic commands preserve upstream data and run in the owned session", async () => {
  class CommandEngine extends FakeEngine {
    override async run(request: EngineRequest): Promise<EngineJsonResult> {
      this.requests.push(request);
      return {
        success: true,
        data: [{ name: "core", content: "Version-matched guide" }],
      };
    }
  }
  const engine = new CommandEngine();
  const browser = new BrowserController(engine);

  const result = await browser.command({ command: "skills", args: ["get", "core"] }, undefined, ctx);

  assert.equal(engine.requests[0]?.session, result.details.session);
  assert.equal(engine.requests[0]?.cwd, ctx.cwd);
  assert.equal(engine.requests[0]?.command, "skills");
  assert.deepEqual(engine.requests[0]?.args, ["get", "core"]);
  assert.deepEqual(JSON.parse(result.content[0].text), [{ name: "core", content: "Version-matched guide" }]);
  assert.equal(result.details.operation, "browser_command");
});

test("generic commands pass special characters literally", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  engine.requests.length = 0;
  const args = ["two words", "$(touch /tmp/nope)", "left|right", ">file", "a;b", "one\ntwo"];

  await browser.command({ command: "eval", args }, undefined, ctx);

  assert.deepEqual(engine.requests[0]?.args, args);
});

test("large generic command output is bounded by the final guard", async () => {
  class LargeCommandEngine extends FakeEngine {
    override async run(request: EngineRequest): Promise<EngineJsonResult> {
      this.requests.push(request);
      return { success: true, data: "line\n".repeat(20_000) };
    }
  }
  const browser = new BrowserController(new LargeCommandEngine());

  const result = await browser.command({ command: "skills", args: ["get", "core", "--full"] }, undefined, ctx);

  assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 60_000);
});

test("a generic command from a closed state remains covered by terminal cleanup", async () => {
  const engine = new FakeEngine();
  engine.snapshotData = { message: "plain browser output" };
  const browser = new BrowserController(engine);

  await browser.command({ command: "snapshot" }, undefined, ctx);
  assert.equal(browser.status(ctx).isOpen, false);

  await browser.closeAll();
  assert.equal(engine.closeCalls, 1);
});

test("a successful generic close reconciles owned session state and cleanup", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  engine.requests.length = 0;
  engine.snapshotData = {
    url: "http://localhost:3000/incidental-close-metadata",
    title: "Already closed",
  };

  await browser.command({ command: "close" }, undefined, ctx);

  assert.equal(browser.status(ctx).isOpen, false);
  assert.equal(engine.requests[0]?.command, "close");
  const closedAgain = await browser.close(undefined, ctx);
  assert.equal(closedAgain.details.alreadyClosed, true);
  assert.equal(engine.closeCalls, 0);
});

test("successful generic close aliases reconcile owned session state", async () => {
  for (const command of ["quit", "exit"]) {
    const engine = new FakeEngine();
    const browser = new BrowserController(engine);
    await browser.open({ url: "http://localhost:3000" }, undefined, ctx);

    await browser.command({ command }, undefined, ctx);

    assert.equal(browser.status(ctx).isOpen, false);
    assert.equal((await browser.close(undefined, ctx)).details.alreadyClosed, true);
    assert.equal(engine.closeCalls, 0);
  }
});

test("close help preserves the open session and its cleanup obligation", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);

  await browser.command({ command: "close", args: ["--help"] }, undefined, ctx);

  assert.equal(browser.status(ctx).isOpen, true);
  const closed = await browser.close(undefined, ctx);
  assert.equal(closed.details.alreadyClosed, false);
  assert.equal(engine.closeCalls, 1);
});

test("snapshot queued after close runs after the close completes", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);

  const closing = browser.close(undefined, ctx);
  const snapshot = browser.command(snapshotCommand, undefined, ctx);
  await closing;

  await snapshot;
  assert.equal(engine.closeCalls, 1);
  assert.equal(engine.requests.at(-1)?.command, "snapshot");
});

test("generic snapshot reports fresh upstream page metadata", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000/start" }, undefined, ctx);
  engine.snapshotData = {
    snapshot: "heading \"Next page\"",
    url: "http://localhost:3000/next",
    title: "Next page",
  };

  const result = await browser.command(snapshotCommand, undefined, ctx);

  assert.equal(result.details.url, "http://localhost:3000/next");
  assert.equal(result.details.title, "Next page");
});

test("open prefers metadata from its immediate snapshot", async () => {
  const engine = new FakeEngine();
  engine.snapshotData = {
    snapshot: "heading \"Redirected\"",
    url: "http://localhost:3000/redirected",
    title: "Redirected",
  };
  const browser = new BrowserController(engine);

  const result = await browser.open({ url: "http://localhost:3000/start" }, undefined, ctx);

  assert.equal(result.details.url, "http://localhost:3000/redirected");
  assert.equal(result.details.title, "Redirected");
});

test("closeAll closes every open session owned by the extension", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);
  const otherCtx = {
    cwd: "/other-project",
    sessionManager: { getSessionId: () => "other-pi-session" },
  };
  await browser.open({ url: "http://localhost:3000/one" }, undefined, ctx);
  await browser.open({ url: "http://localhost:3000/two" }, undefined, otherCtx);

  await browser.closeAll(undefined);

  assert.equal(engine.closeCalls, 2);
  assert.equal(browser.status(ctx).isOpen, false);
  assert.equal(browser.status(otherCtx).isOpen, false);
});

test("closeAll attempts every owned session when one close fails", async () => {
  class PartiallyFailingEngine extends FakeEngine {
    override async close(): Promise<void> {
      this.closeCalls += 1;
      if (this.closeCalls === 1) throw new Error("first close failed");
    }
  }
  const engine = new PartiallyFailingEngine();
  const browser = new BrowserController(engine);
  const otherCtx = {
    cwd: "/other-project",
    sessionManager: { getSessionId: () => "other-pi-session" },
  };
  await browser.open({ url: "http://localhost:3000/one" }, undefined, ctx);
  await browser.open({ url: "http://localhost:3000/two" }, undefined, otherCtx);

  await assert.rejects(browser.closeAll(undefined), /first close failed/);

  assert.equal(engine.closeCalls, 2);
  assert.equal(browser.status(otherCtx).isOpen, false);
});

test("failed open closes a daemon that may have started before failure", async () => {
  class FailedOpenEngine extends FakeEngine {
    override async run(request: EngineRequest): Promise<EngineJsonResult> {
      this.requests.push(request);
      throw new Error("Chrome failed after daemon launch");
    }
  }
  const engine = new FailedOpenEngine();
  const browser = new BrowserController(engine);

  await assert.rejects(browser.open({ url: "http://localhost:3000" }, undefined, ctx), /Chrome failed/);
  assert.equal(engine.closeCalls, 1);
});

test("fill validates before queueing", async () => {
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  engine.requests.length = 0;

  await assert.rejects(browser.fill({ target: "#email" }, undefined, ctx), /^BrowserError: browser_invalid_input:/);
  await assert.rejects(
    browser.fill({ target: "#email", value: "literal", valueFromEnv: "TEST_VALUE" }, undefined, ctx),
    /^BrowserError: browser_invalid_input:/,
  );
  await assert.rejects(browser.fill({ target: "", value: "x" }, undefined, ctx), /^BrowserError: browser_invalid_input:/);
  assert.equal(engine.requests.length, 0);

  await browser.fill({ target: "#email", value: "person@example.test" }, undefined, ctx);
  assert.deepEqual(engine.requests.map((request) => [request.command, ...request.args]), [
    ["fill", "#email", "person@example.test"],
  ]);
});

test("fill resolves an environment-backed value for the engine and reports the variable name", async (t) => {
  const variable = "PI_BROWSER_TEST_PASSWORD";
  const secret = "sentinel-environment-password";
  const previous = process.env[variable];
  process.env[variable] = secret;
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  engine.requests.length = 0;

  const result = await browser.fill({ target: "#password", valueFromEnv: variable }, undefined, ctx);

  assert.deepEqual(engine.requests[0]?.args, ["#password", secret]);
  assert.equal(result.details.valueFromEnv, variable);
});

test("environment-backed fill failures expose only the variable name", async (t) => {
  const variable = "PI_BROWSER_TEST_MISSING_VALUE";
  const previous = process.env[variable];
  delete process.env[variable];
  t.after(() => {
    if (previous !== undefined) process.env[variable] = previous;
  });
  const engine = new FakeEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  engine.requests.length = 0;

  await assert.rejects(
    browser.fill({ target: "#password", valueFromEnv: variable }, undefined, ctx),
    (error: unknown) => {
      assert.match(String(error), new RegExp(variable));
      return true;
    },
  );
  assert.equal(engine.requests.length, 0);
});

test("screenshot maps owned path, full-page, and annotation options", async () => {
  const engine = new FakeEngine();
  const allocated: string[] = [];
  let capture = 0;
  const artifacts = {
    root: "/tmp/pi-browser/owned",
    async cleanup() {},
    async allocate(extension = ".png") {
      allocated.push(extension);
      capture += 1;
      return `/tmp/pi-browser/owned/capture-${capture}.png`;
    },
  };
  const browser = new BrowserController(engine, undefined, artifacts);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  engine.requests.length = 0;

  const result = await browser.screenshot({ fullPage: true, annotate: true }, undefined, ctx);
  const defaults = await browser.screenshot({}, undefined, ctx);

  assert.deepEqual(allocated, [".png", ".png"]);
  assert.deepEqual(engine.requests.map((request) => [request.command, ...request.args]), [
    ["screenshot", "--full", "--annotate", "/tmp/pi-browser/owned/capture-1.png"],
    ["screenshot", "/tmp/pi-browser/owned/capture-2.png"],
  ]);
  assert.deepEqual(result.details.artifact, {
    kind: "screenshot",
    path: "/tmp/pi-browser/owned/capture-1.png",
  });
  assert.match(defaults.details.artifact?.path ?? "", /capture-2\.png$/);
  assert.match(result.content[0].text, /capture-1\.png/);
  assert.doesNotMatch(result.content[0].text, /base64|iVBOR/);
});

test("screenshot rejects caller paths before artifact allocation or engine invocation", async () => {
  const engine = new FakeEngine();
  let allocations = 0;
  const artifacts = {
    root: "/tmp/pi-browser/owned",
    async cleanup() {},
    async allocate() {
      allocations += 1;
      return "/tmp/unused.png";
    },
  };
  const browser = new BrowserController(engine, undefined, artifacts);

  await assert.rejects(
    browser.screenshot({ path: "/tmp/caller.png" } as never, undefined, ctx),
    /^BrowserError: browser_invalid_input:/,
  );
  assert.equal(allocations, 0);
  assert.equal(engine.requests.length, 0);
});

test("stale ref errors surface upstream text and the queue survives failure", async () => {
  class StaleEngine extends FakeEngine {
    override async run(request: EngineRequest): Promise<EngineJsonResult> {
      this.requests.push(request);
      if (request.command === "click" && request.args[0] === "@e9") throw new Error("Unknown ref: e9");
      return request.command === "open"
        ? { success: true, data: { url: request.args[0], title: "Fixture" } }
        : { success: true, data: this.snapshotData };
    }
  }
  const engine = new StaleEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);

  await assert.rejects(browser.command({ command: "click", args: ["@e9"] }, undefined, ctx), /Unknown ref: e9/);
  await browser.command({ command: "click", args: ["@e2"] }, undefined, ctx);
});

test("sibling actions execute in submission order and a failure does not poison the queue", async () => {
  class OrderedEngine extends FakeEngine {
    override async run(request: EngineRequest): Promise<EngineJsonResult> {
      this.requests.push(request);
      if (request.command === "fill" && request.args[1] === "fail") throw new Error("fill failed");
      return request.command === "open"
        ? { success: true, data: { url: request.args[0], title: "Fixture" } }
        : { success: true, data: this.snapshotData };
    }
  }
  const engine = new OrderedEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  engine.requests.length = 0;

  const failed = browser.fill({ target: "#email", value: "fail" }, undefined, ctx);
  const appended = browser.command({ command: "type", args: ["#email", "next"] }, undefined, ctx);
  await assert.rejects(failed, /fill failed/);
  await appended;

  assert.deepEqual(engine.requests.map((request) => [request.command, ...request.args]), [
    ["fill", "#email", "fail"],
    ["type", "#email", "next"],
  ]);
});

test("commands forward Pi cancellation to the engine", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  class SignalEngine extends FakeEngine {
    override async run(request: EngineRequest, signal?: AbortSignal): Promise<EngineJsonResult> {
      signals.push(signal);
      return super.run(request);
    }
  }
  const engine = new SignalEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  signals.length = 0;
  const controller = new AbortController();

  await browser.command({ command: "press", args: ["Enter"] }, controller.signal, ctx);
  await browser.fill({ target: "#email", value: "x" }, controller.signal, ctx);

  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal === controller.signal));
});

test("an in-flight wait cancellation releases the queue", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  class InFlightWaitEngine extends FakeEngine {
    override async run(request: EngineRequest, signal?: AbortSignal): Promise<EngineJsonResult> {
      this.requests.push(request);
      if (request.command === "wait") {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(browserError("browser_cancelled", "client interrupted; browser-side completion is unknown"));
            return;
          }
          signal?.addEventListener("abort", () => reject(browserError("browser_cancelled", "client interrupted; browser-side completion is unknown")), { once: true });
        });
      }
      return request.command === "open"
        ? { success: true, data: { url: request.args[0], title: "Fixture" } }
        : { success: true, data: this.snapshotData };
    }
  }
  const engine = new InFlightWaitEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  const controller = new AbortController();

  const waiting = browser.command({ command: "wait", args: ["30000"] }, controller.signal, ctx);
  await started;
  controller.abort();

  await assert.rejects(waiting, /^BrowserError: browser_cancelled:/);
  await browser.command({ command: "click", args: ["@e2"] }, undefined, ctx);
});

test("a queued command aborted before executor entry releases the queue", async () => {
  let release!: () => void;
  let markStarted!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  class QueuedCancellationEngine extends FakeEngine {
    override async run(request: EngineRequest, signal?: AbortSignal): Promise<EngineJsonResult> {
      if (signal?.aborted) throw browserError("browser_cancelled", "client interrupted; browser-side completion is unknown");
      this.requests.push(request);
      if (request.command === "hover") {
        markStarted();
        await barrier;
      }
      return request.command === "open"
        ? { success: true, data: { url: request.args[0], title: "Fixture" } }
        : { success: true, data: this.snapshotData };
    }
  }
  const engine = new QueuedCancellationEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);

  const blocking = browser.command({ command: "hover", args: ["#blocking"] }, undefined, ctx);
  await started;
  const controller = new AbortController();
  const queued = browser.command({ command: "click", args: ["@e2"] }, controller.signal, ctx);
  controller.abort();
  release();

  await blocking;
  await assert.rejects(queued, /^BrowserError: browser_cancelled:/);
  assert.equal(engine.requests.filter((request) => request.command === "click").length, 0);
  await browser.command({ command: "click", args: ["@e2"] }, undefined, ctx);
});

test("timed-out page command releases the queue", async () => {
  class TimingOutEngine extends FakeEngine {
    timedOut = false;

    override async run(request: EngineRequest): Promise<EngineJsonResult> {
      this.requests.push(request);
      if (request.command === "click" && !this.timedOut) {
        this.timedOut = true;
        throw browserError("browser_timeout", "click timed out; browser-side completion is unknown");
      }
      return request.command === "open"
        ? { success: true, data: { url: request.args[0], title: "Fixture" } }
        : { success: true, data: this.snapshotData };
    }
  }
  const engine = new TimingOutEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);

  await assert.rejects(browser.command({ command: "click", args: ["@e2"] }, undefined, ctx), /^BrowserError: browser_timeout:/);
  await browser.command({ command: "click", args: ["@e2"] }, undefined, ctx);
});

test("an engine timeout releases the controller session queue", async () => {
  let nextSnapshotTimesOut = false;
  const engine = new AgentBrowserEngine(withCompatibleCli(async (_command, args) => {
    if (args.includes("snapshot") && nextSnapshotTimesOut) {
      nextSnapshotTimesOut = false;
      return { code: null, stdout: "", stderr: "", killed: true };
    }
    return args.includes("open")
      ? { code: 0, stdout: JSON.stringify({ success: true, data: { url: "http://localhost:3000", title: "Fixture" } }), stderr: "", killed: false }
      : { code: 0, stdout: JSON.stringify({ success: true, data: { snapshot: "button Continue [ref=e1]" } }), stderr: "", killed: false };
  }));
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);
  nextSnapshotTimesOut = true;

  const failed = browser.command(snapshotCommand, undefined, ctx);
  const recovered = browser.command(snapshotCommand, undefined, ctx);

  await assert.rejects(failed, /^BrowserError: browser_timeout:/);
  assert.match((await recovered).content[0].text, /Continue/);
});

test("cancelled close surfaces the cancellation and keeps the session open", async () => {
  class CloseCancellationEngine extends FakeEngine {
    override async close(): Promise<void> {
      throw browserError("browser_cancelled", "close cancelled");
    }
  }
  const engine = new CloseCancellationEngine();
  const browser = new BrowserController(engine);
  await browser.open({ url: "http://localhost:3000" }, undefined, ctx);

  await assert.rejects(browser.close(undefined, ctx), /^BrowserError: browser_cancelled:/);
});

test("headed launch failure recommends headless without installation", async () => {
  class DisplaylessEngine extends FakeEngine {
    override async run(request: EngineRequest): Promise<EngineJsonResult> {
      this.requests.push(request);
      if (request.command === "open" && request.headed) throw browserError("browser_upstream_error", "no display");
      return super.run(request);
    }
  }
  const engine = new DisplaylessEngine();
  const browser = new BrowserController(engine);

  await assert.rejects(
    browser.open({ url: "http://localhost:3000", headed: true }, undefined, ctx),
    /headed false|headed off/i,
  );
  assert.doesNotMatch(String(await browser.open({ url: "http://localhost:3000", headed: false }, undefined, ctx)), /install/i);
});
