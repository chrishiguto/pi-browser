import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCommandPlan, formatCommandResult } from "../../src/browser.ts";

test("literal command planning preserves argv data without shell interpretation", () => {
  const args = [
    "two words",
    '"quoted"',
    "$(touch /tmp/must-not-exist)",
    "left|right",
    ">redirect",
    "first;second",
    "line one\nline two",
  ];

  assert.deepEqual(buildCommandPlan({ command: "eval", args }), {
    command: "eval",
    args,
    responseFormat: "json",
  });
});

test("subcommand help selects bounded plaintext without allowing a top-level flag", () => {
  assert.deepEqual(buildCommandPlan({ command: "get", args: ["--help"] }), {
    command: "get",
    args: ["--help"],
    responseFormat: "text",
  });
  assert.deepEqual(buildCommandPlan({ command: "skills", args: ["-h"] }), {
    command: "skills",
    args: ["-h"],
    responseFormat: "text",
  });
  assert.throws(() => buildCommandPlan({ command: "--help" }), /^BrowserError: browser_invalid_input:/);
});

test("literal command planning rejects executable and managed-global overrides", () => {
  for (const command of ["", " ", "--version", "agent-browser", "./agent-browser", "/usr/bin/agent-browser", "get title"] ) {
    assert.throws(() => buildCommandPlan({ command, args: [] }), /^BrowserError: browser_invalid_input:/);
  }

  for (const arg of [
    "--session", "--session=other", "--namespace", "--namespace=other",
    "--json", "--max-output", "--max-output=1", "--content-boundaries", "--no-content-boundaries",
    "--profile", "--profile=/tmp/raw-profile",
  ]) {
    assert.throws(() => buildCommandPlan({ command: "get", args: [arg] }), /^BrowserError: browser_invalid_input:/);
  }
  for (const command of ["close", "quit", "exit"]) {
    for (const option of ["--all", "--all=true"]) {
      assert.throws(() => buildCommandPlan({ command, args: [option] }), /escape the extension-owned session/);
    }
  }
});

test("literal command planning admits previously gated capability flags", () => {
  for (const params of [
    { command: "screenshot", args: ["/tmp/caller.png"] },
    { command: "session", args: ["list"] },
    { command: "cookies", args: ["get"] },
    { command: "network", args: ["har", "/tmp/trace.har"] },
    { command: "read", args: ["https://docs.example/page"] },
    { command: "get", args: ["--user-agent", "test", "title"] },
    { command: "open", args: ["https://example.test", "--state=/tmp/auth.json"] },
  ]) {
    assert.doesNotThrow(() => buildCommandPlan(params));
  }
});

test("literal command planning validates only its structural contract", () => {
  assert.throws(() => buildCommandPlan(null as never), /^BrowserError: browser_invalid_input:/);
  assert.throws(() => buildCommandPlan({ command: "get", args: ["title", 42 as never] }), /^BrowserError: browser_invalid_input:/);
  assert.throws(() => buildCommandPlan({ command: "get", environment: "staging" } as never), /^BrowserError: browser_invalid_input:/);
  assert.throws(() => buildCommandPlan({ command: "get", extra: true } as never), /^BrowserError: browser_invalid_input:/);
});

test("generic result formatting preserves arbitrary upstream data", () => {
  const data = [{ name: "core", content: "guide\ntext" }];
  const text = formatCommandResult({ success: true, data });

  assert.deepEqual(JSON.parse(text), data);
  assert.match(text, /guide\\ntext/);
});

test("generic result formatting retains successful top-level payload fields", () => {
  const text = formatCommandResult({
    success: true,
    checks: [{ id: "chrome.installed", status: "pass" }],
  });

  assert.deepEqual(JSON.parse(text), {
    checks: [{ id: "chrome.installed", status: "pass" }],
  });
});
