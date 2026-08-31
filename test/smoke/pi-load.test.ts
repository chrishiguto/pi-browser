import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

test("installed Pi loads and registers the extension without a model call", { timeout: 15_000 }, async () => {
  const child = spawn("pi", [
    "--mode", "rpc",
    "--offline",
    "--no-session",
    "--approve",
    "--no-extensions",
    "--extension", new URL("../../extensions/browser/index.ts", import.meta.url).pathname,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(`${JSON.stringify({ id: "smoke", type: "get_commands" })}\n`);

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(code, 0, stderr);
  const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
  const response = messages.find((message) => message.id === "smoke");
  assert.equal(response?.success, true);
  assert.ok(response.data.commands.some((command: { name?: string }) => command.name === "browser"));
  assert.ok(response.data.commands.some((command: { name?: string; source?: string }) => (
    command.name === "skill:browser" && command.source === "skill"
  )));
});
