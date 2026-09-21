import { spawn } from "node:child_process";

import type { PiExecutor } from "../../src/agent-browser.ts";

// Test stand-in for pi.exec: spawn without a shell, capture output, honor
// timeout and abort by terminating the child.
export const nodeExecutorForEnv = (env: NodeJS.ProcessEnv): PiExecutor => (command, args, options = {}) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd: options.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let killed = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    killed = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 500).unref();
  };
  const abort = () => stop();
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      killed,
    });
  };

  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  if (options.timeout) {
    timer = setTimeout(stop, options.timeout);
    timer.unref();
  }
  child.stdout.on("data", (value: Buffer) => stdout.push(value));
  child.stderr.on("data", (value: Buffer) => stderr.push(value));
  child.once("error", (error) => {
    stderr.push(Buffer.from(error.message));
    finish(1);
  });
  child.once("close", finish);
});

export const nodeExecutor = nodeExecutorForEnv(process.env);
