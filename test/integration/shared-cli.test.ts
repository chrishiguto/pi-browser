import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentBrowserEngine, AGENT_BROWSER_VERSION } from "../../src/agent-browser.ts";
import { startFixture } from "../fixture/server.ts";
import { nodeExecutorForEnv } from "../helpers/node-executor.ts";

test("terminal and Pi share the nix browser without downloaded browser assets", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-browser-clean-home-"));
  const fixture = await startFixture();
  const exec = nodeExecutorForEnv({
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    AGENT_BROWSER_HOME: join(home, ".agent-browser"),
    AGENT_BROWSER_EXECUTABLE_PATH: undefined,
    PUPPETEER_CACHE_DIR: join(home, ".cache", "puppeteer"),
  });
  const terminalSession = `terminal-${process.pid}`;
  const piSession = `pi-clean-${process.pid}`;
  const engine = new AgentBrowserEngine(exec, undefined, ["--no-sandbox"]);
  // Browsers close before the fixture server: a page still open against the
  // server can keep its connection alive and hold server.close() open.
  // Every cleanup call is bounded so a stalled cli cannot hold the suite.
  t.after(async () => {
    try {
      const closed = await exec("agent-browser", ["--session", terminalSession, "close"], { timeout: 10_000 });
      assert.equal(closed.code, 0, closed.stderr || closed.stdout);
      await engine.close(piSession);
    } finally {
      await fixture.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  const version = await exec("agent-browser", ["--version"], { timeout: 10_000 });
  assert.equal(version.stdout.trim(), `agent-browser ${AGENT_BROWSER_VERSION}`);
  const terminal = await exec("agent-browser", ["--session", terminalSession, "--args", "--no-sandbox", "--json", "open", fixture.url], { timeout: 30_000 });
  assert.equal(terminal.code, 0, terminal.stderr || terminal.stdout);
  assert.equal(JSON.parse(terminal.stdout).success, true);

  const opened = await engine.run({ session: piSession, command: "open", args: [fixture.url] });
  assert.equal(opened.success, true);
  const screenshot = join(home, "page.png");
  await engine.run({ session: piSession, command: "screenshot", args: [screenshot] });
  assert.ok((await stat(screenshot)).size > 0);
  await assert.rejects(stat(join(home, ".agent-browser", "browsers")), { code: "ENOENT" });
  await assert.rejects(stat(join(home, ".cache", "puppeteer")), { code: "ENOENT" });
});
