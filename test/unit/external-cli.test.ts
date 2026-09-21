import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentBrowserEngine, AGENT_BROWSER_VERSION, type ExecResult } from "../../src/agent-browser.ts";

const request = { session: "owned", command: "open", args: ["about:blank"] };
const ok: ExecResult = { code: 0, stdout: JSON.stringify({ success: true }), stderr: "", killed: false };

test("missing and incompatible cli block operations and recover without reload", async () => {
  let version: string | undefined;
  const actions: string[][] = [];
  const engine = new AgentBrowserEngine(async (command, args) => {
    assert.equal(command, "agent-browser");
    // pi's exec never rejects: a spawn failure resolves as exit 1 with empty output.
    if (version === undefined) return { code: 1, stdout: "", stderr: "", killed: false };
    if (args[0] === "--version") return { code: 0, stdout: version, stderr: "", killed: false };
    actions.push(args);
    return ok;
  });

  await assert.rejects(engine.run(request), /chezmoi apply.*exited with code 1/);
  version = "0.35.1";
  await assert.rejects(engine.run(request), /incompatible; expected 0\.37\.1/);
  assert.deepEqual(actions, []);

  version = AGENT_BROWSER_VERSION;
  await engine.run(request);
  assert.equal(actions.length, 1);

  version = "0.38.0";
  await assert.rejects(engine.run(request), /incompatible/);
  assert.equal(actions.length, 1);
});

test("every executor failure shape for the probe carries the provisioning hint", async () => {
  const shapes: Array<() => Promise<ExecResult>> = [
    // test helper and shell-less spawn wrappers: exit 1 with the spawn error on stderr
    async () => ({ code: 1, stdout: "", stderr: "spawn agent-browser ENOENT", killed: false }),
    // an executor that rejects outright
    async () => { throw Object.assign(new Error("spawn agent-browser ENOENT"), { code: "ENOENT" }); },
  ];
  for (const exec of shapes) {
    const engine = new AgentBrowserEngine(exec);
    await assert.rejects(engine.checkCompatibility(), /^BrowserError: browser_upstream_error: Run chezmoi apply.*ENOENT/);
  }
});

test("malformed and prerelease versions cannot pass compatibility", async () => {
  for (const stdout of ["not a version", "unexpected 0.37.1 text", "agent-browser 0.37.1-beta.1"]) {
    const engine = new AgentBrowserEngine(async () => ({ code: 0, stdout, stderr: "", killed: false }));
    await assert.rejects(engine.checkCompatibility(), /^BrowserError: browser_protocol_error: .*invalid version response/);
  }
});

test("a request probes once even when the daemon socket vanishes", async () => {
  let probes = 0;
  let opens = 0;
  const engine = new AgentBrowserEngine(async (_command, args) => {
    if (args[0] === "--version") {
      probes++;
      return { code: 0, stdout: AGENT_BROWSER_VERSION, stderr: "", killed: false };
    }
    opens++;
    return opens === 1
      ? { code: 1, stdout: JSON.stringify({ success: false, error: "Failed to connect: No such file or directory (os error 2)" }), stderr: "", killed: false }
      : ok;
  });

  await engine.run(request);

  assert.equal(opens, 2);
  assert.equal(probes, 1);
});

test("close is not gated by the compatibility probe", async () => {
  const observed: string[][] = [];
  const engine = new AgentBrowserEngine(async (_command, args) => {
    observed.push(args);
    if (args[0] === "--version") throw new Error("close must not probe");
    return ok;
  });

  await engine.close("owned");

  assert.deepEqual(observed, [["--session", "owned", "--json", "close"]]);
});
