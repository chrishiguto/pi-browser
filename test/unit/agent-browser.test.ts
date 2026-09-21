import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentBrowserEngine,
  AGENT_BROWSER_VERSION,
  type PiExecutor,
} from "../../src/agent-browser.ts";
import { withCompatibleCli } from "../helpers/compatible-exec.ts";

function compatibleEngine(exec: PiExecutor): AgentBrowserEngine {
  return new AgentBrowserEngine(withCompatibleCli(exec));
}

test("adapter invokes the shared executable directly", async () => {
  const calls: Parameters<PiExecutor>[] = [];
  const exec: PiExecutor = async (...args) => {
    calls.push(args);
    return { code: 0, stdout: `${AGENT_BROWSER_VERSION}\n`, stderr: "", killed: false };
  };
  const engine = new AgentBrowserEngine(exec);

  const version = await engine.version();

  assert.equal(version, AGENT_BROWSER_VERSION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "agent-browser");
  assert.deepEqual(calls[0][1], ["--version"]);
  assert.equal(calls[0][2]?.timeout, 10_000);
});

test("diagnostic errors are bounded and categorized", async () => {
  const engine = new AgentBrowserEngine(async () => ({
    code: 2,
    stdout: "",
    stderr: "x".repeat(100_000),
    killed: false,
  }));

  await assert.rejects(engine.version(), (error: unknown) => {
    assert.match(String(error), /^BrowserError: browser_upstream_error:/);
    assert.ok(String(error).length < 5_000);
    return true;
  });
});

test("upstream errors are bounded without guessing secrets in upstream text", async () => {
  const engine = new AgentBrowserEngine(async () => ({
    code: 1,
    stdout: "",
    stderr: "open failed at http://localhost:3000/?token=top-secret&view=compact",
    killed: false,
  }));

  await assert.rejects(engine.version(), (error: unknown) => {
    assert.match(String(error), /token=top-secret/);
    return true;
  });
});

test("diagnostic cancellation does not imply a browser-side operation", async () => {
  const controller = new AbortController();
  controller.abort();
  const engine = new AgentBrowserEngine(async () => {
    throw new Error("must not execute");
  });

  await assert.rejects(engine.version(controller.signal), (error: unknown) => {
    assert.match(String(error), /interrupted agent-browser version/);
    assert.doesNotMatch(String(error), /browser-side completion|Snapshot/);
    return true;
  });
});

test("browser cancellation reports client interruption and the required ref recovery", async () => {
  const controller = new AbortController();
  controller.abort();
  const engine = compatibleEngine(async () => {
    throw new Error("must not execute");
  });

  await assert.rejects(engine.run({ session: "owned", command: "click", args: ["#submit"] }, controller.signal), (error: unknown) => {
    assert.match(String(error), /client.*browser-side completion is unknown/i);
    assert.match(String(error), /Snapshot before the next ref action/);
    return true;
  });
});

test("browser requests inject every owned global before the action", async () => {
  let observedArgs: string[] = [];
  let observedCwd: string | undefined;
  const engine = compatibleEngine(async (_command, args, options) => {
    observedArgs = args;
    observedCwd = options?.cwd;
    return {
      code: 0,
      stdout: JSON.stringify({ success: true, data: { url: "http://localhost:3000/" } }),
      stderr: "",
      killed: false,
    };
  });

  const result = await engine.run({
    session: "pi-browser-owned",
    cwd: "/project/runtime-cwd",
    command: "open",
    args: ["http://localhost:3000/"],
    headed: true,
  });

  assert.equal(result.success, true);
  assert.equal(observedCwd, "/project/runtime-cwd");
  assert.deepEqual(observedArgs, [
    "--session", "pi-browser-owned",
    "--json",
    "--content-boundaries",
    "--max-output", "50000",
    "--headed",
    "open", "http://localhost:3000/",
  ]);
});

test("browser execution uses bounded launch, routine, wait, and shutdown timeouts", async () => {
  const timeouts: Array<number | undefined> = [];
  const engine = compatibleEngine(async (_command, _args, options) => {
    timeouts.push(options?.timeout);
    return { code: 0, stdout: JSON.stringify({ success: true }), stderr: "", killed: false };
  });

  await engine.run({ session: "owned", command: "open", args: ["http://localhost"], timeoutClass: "navigation" });
  await engine.run({ session: "owned", command: "click", args: ["#submit"] });
  await engine.run({ session: "owned", command: "wait", args: ["30000"], timeoutClass: "wait" });
  await engine.close("owned");

  assert.deepEqual(timeouts, [60_000, 30_000, 35_000, 10_000]);
});

test("browser requests keep shell metacharacters as literal launcher arguments", async () => {
  let observedCommand = "";
  let observedArgs: string[] = [];
  const engine = compatibleEngine(async (command, args) => {
    observedCommand = command;
    observedArgs = args;
    return {
      code: 0,
      stdout: JSON.stringify({ success: true, data: { value: "ok" } }),
      stderr: "",
      killed: false,
    };
  });
  const literals = ["two words", "$(touch /tmp/nope)", "a|b", ">file", "a;b", "one\ntwo"];

  await engine.run({ session: "owned", command: "eval", args: literals });

  assert.equal(observedCommand, "agent-browser");
  assert.deepEqual(observedArgs.slice(-literals.length - 1), ["eval", ...literals]);
});

test("browser requests can return bounded plaintext subcommand help", async () => {
  let observedArgs: string[] = [];
  const engine = compatibleEngine(async (_command, args) => {
    observedArgs = args;
    return {
      code: 0,
      stdout: "Usage: agent-browser get <what> [selector]\n",
      stderr: "",
      killed: false,
    };
  });

  const result = await engine.run({
    session: "owned",
    command: "get",
    args: ["--help"],
    responseFormat: "text",
  });

  assert.equal(result.data, "Usage: agent-browser get <what> [selector]\n");
  assert.deepEqual(observedArgs.slice(-2), ["get", "--help"]);
  assert.ok(observedArgs.includes("--json"));
  assert.ok(observedArgs.includes("--max-output"));
});

test("nonzero subcommand help cannot become a successful plaintext result", async () => {
  const secretArg = "private-help-argument";
  const engine = compatibleEngine(async () => ({
    code: 2,
    stdout: JSON.stringify({ success: false, error: "help failed" }),
    stderr: `help failed near ${secretArg}`,
    killed: false,
  }));

  await assert.rejects(
    engine.run({ session: "owned", command: "get", args: ["--help", secretArg], responseFormat: "text" }),
    (error: unknown) => {
      assert.match(String(error), /^BrowserError: browser_upstream_error:/);
      assert.doesNotMatch(String(error), new RegExp(secretArg));
      return true;
    },
  );
});

test("unknown command errors surface the upstream protocol error", async () => {
  const engine = compatibleEngine(async () => ({
    code: 2,
    stdout: JSON.stringify({ success: false, error: "Unknown command" }),
    stderr: "extra stderr noise",
    killed: false,
  }));

  await assert.rejects(
    engine.run({ session: "owned", command: "not-a-command", args: [] }),
    /^BrowserError: browser_upstream_error: Unknown command$/,
  );
});

test("profile requests map the owned profile flag before the action", async () => {
  let observedArgs: string[] = [];
  const engine = compatibleEngine(async (_command, args) => {
    observedArgs = args;
    return {
      code: 0,
      stdout: JSON.stringify({ success: true, data: { url: "https://example.com/" } }),
      stderr: "",
      killed: false,
    };
  });

  await engine.run({
    session: "profiled",
    cwd: process.cwd(),
    command: "open",
    args: ["https://example.com/"],
    profile: "/owned/profiles/staging",
  });

  assert.deepEqual(observedArgs, [
    "--session", "profiled",
    "--json",
    "--content-boundaries",
    "--max-output", "50000",
    "--profile", "/owned/profiles/staging",
    "open", "https://example.com/",
  ]);
});

test("open retries once when a closing daemon socket vanishes", async () => {
  let calls = 0;
  const engine = compatibleEngine(async () => {
    calls += 1;
    return calls === 1
      ? {
          code: 1,
          stdout: JSON.stringify({ success: false, error: "Failed to connect: No such file or directory (os error 2)" }),
          stderr: "",
          killed: false,
        }
      : { code: 0, stdout: JSON.stringify({ success: true, data: { url: "https://example.com" } }), stderr: "", killed: false };
  });

  const result = await engine.run({
    session: "relaunch",
    command: "open",
    args: ["https://example.com"],
  });

  assert.equal(result.success, true);
  assert.equal(calls, 2);
});

test("close issues a launch-independent command in the owned session", async () => {
  let observedArgs: string[] = [];
  const engine = compatibleEngine(async (_command, args) => {
    observedArgs = args;
    return {
      code: 0,
      stdout: JSON.stringify({ success: true, data: { closed: true } }),
      stderr: "",
      killed: false,
    };
  });

  await engine.close("pi-browser-owned");

  assert.deepEqual(observedArgs, [
    "--session", "pi-browser-owned", "--json", "close",
  ]);
});

test("browser request rejects malformed and unsuccessful protocol results", async () => {
  const malformed = compatibleEngine(async () => ({ code: 0, stdout: "not-json", stderr: "", killed: false }));
  await assert.rejects(malformed.run({ session: "owned", command: "snapshot", args: [] }), /^BrowserError: browser_protocol_error:/);

  const unsuccessful = compatibleEngine(async () => ({
    code: 0,
    stdout: JSON.stringify({ success: false, error: "snapshot failed" }),
    stderr: "",
    killed: false,
  }));
  await assert.rejects(unsuccessful.run({ session: "owned", command: "snapshot", args: [] }), /^BrowserError: browser_upstream_error:/);
});

test("browser requests preserve valid JSON beyond the diagnostic capture bound", async () => {
  const text = "x".repeat(200_000);
  const engine = compatibleEngine(async () => ({
    code: 0,
    stdout: JSON.stringify({ success: true, data: { snapshot: text } }),
    stderr: "",
    killed: false,
  }));

  const result = await engine.run({ session: "owned", command: "snapshot", args: [] });
  assert.equal((result.data as { snapshot: string }).snapshot.length, text.length);
});

test("browser requests invoke the shared cli directly", async () => {
  let command = "";
  let args: string[] = [];
  const engine = compatibleEngine(async (observedCommand, observedArgs) => {
    command = observedCommand;
    args = observedArgs;
    return { code: 0, stdout: JSON.stringify({ success: true, data: { snapshot: "ok" } }), stderr: "", killed: false };
  });

  await engine.run({ session: "owned", command: "snapshot", args: [] });
  assert.equal(command, "agent-browser");
  assert.equal(args[0], "--session");
});

test("nonzero browser JSON errors are parsed without exposing the protocol envelope", async () => {
  const engine = compatibleEngine(async () => ({
    code: 1,
    stdout: JSON.stringify({
      success: false,
      error: "Unknown ref: e9",
      _boundary: { nonce: "secret-boundary-nonce", origin: "unknown" },
    }),
    stderr: "",
    killed: false,
  }));

  await assert.rejects(engine.run({ session: "owned", command: "click", args: ["@e9"] }), (error: unknown) => {
    assert.match(String(error), /Unknown ref: e9/);
    assert.doesNotMatch(String(error), /secret-boundary-nonce|_boundary/);
    return true;
  });
});

test("valid browser JSON failures surface the upstream error verbatim", async () => {
  const engine = compatibleEngine(async () => ({
    code: 1,
    stdout: JSON.stringify({ success: false, error: "fill #email failed: element is not editable" }),
    stderr: "",
    killed: false,
  }));

  await assert.rejects(
    engine.run({ session: "owned", command: "fill", args: ["#email", "value"] }),
    /^BrowserError: browser_upstream_error: fill #email failed: element is not editable$/,
  );
});

test("nonzero non-JSON browser failures surface bounded stderr diagnostics", async () => {
  const engine = compatibleEngine(async () => ({
    code: 1,
    stdout: "",
    stderr: `browser process crashed during launch\n${"x".repeat(100_000)}`,
    killed: false,
  }));

  await assert.rejects(engine.run({ session: "owned", command: "fill", args: ["#email", "value"] }), (error: unknown) => {
    assert.match(String(error), /^BrowserError: browser_upstream_error: browser process crashed during launch/);
    assert.ok(String(error).length < 5_000);
    return true;
  });
});

test("a sandbox launch failure retries with --no-sandbox and keeps it for later launches", async () => {
  const invocations: string[][] = [];
  let failNextLaunch = true;
  const engine = compatibleEngine(async (_command, args) => {
    invocations.push(args);
    if (failNextLaunch) {
      failNextLaunch = false;
      return {
        code: 1,
        stdout: JSON.stringify({
          success: false,
          error: "Auto-launch failed: Chrome exited early\nChrome stderr:\n  FATAL: No usable sandbox!",
        }),
        stderr: "",
        killed: false,
      };
    }
    return { code: 0, stdout: JSON.stringify({ success: true, data: { url: "https://example.com/" } }), stderr: "", killed: false };
  });

  const opened = await engine.run({ session: "owned", command: "open", args: ["https://example.com/"] });
  await engine.run({ session: "owned", command: "snapshot", args: [] });
  await engine.close("owned");

  assert.equal(opened.success, true);
  assert.equal(invocations.length, 4);
  assert.ok(!invocations[0]!.includes("--args"));
  assert.equal(invocations[1]![invocations[1]!.indexOf("--args") + 1], "--no-sandbox");
  assert.equal(invocations[2]![invocations[2]!.indexOf("--args") + 1], "--no-sandbox");
  assert.ok(!invocations[3]!.includes("--args"));
  assert.equal(invocations[3]!.at(-1), "close");
});

test("browser timeouts identify the requested operation, not the physical session", async () => {
  const engine = compatibleEngine(async () => ({
    code: null,
    stdout: "",
    stderr: "",
    killed: true,
  }));

  await assert.rejects(
    engine.run({ session: "pi-browser-secret-session", command: "wait", args: ["--text", "Done"] }),
    (error: unknown) => {
      assert.match(String(error), /^BrowserError: browser_timeout: wait timed out; browser-side completion is unknown\./);
      assert.match(String(error), /Snapshot before the next ref action/);
      return true;
    },
  );
});
