import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { browserError } from "./errors.ts";

export const AGENT_BROWSER_VERSION = "0.35.1";
const DIAGNOSTIC_TIMEOUT_MS = 10_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 35_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const MAX_DIAGNOSTIC_CHARS = 64 * 1_024;

export interface ExecOptions {
  signal?: AbortSignal;
  timeout?: number;
  cwd?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export type PiExecutor = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export interface EngineJsonResult {
  success: boolean;
  data?: unknown;
  checks?: Array<{ id?: string; status?: string; message?: string }>;
  [key: string]: unknown;
}

export interface EngineRequest {
  session: string;
  cwd?: string;
  command: string;
  args: string[];
  headed?: boolean;
  profile?: string;
  timeoutClass?: "navigation" | "wait";
  responseFormat?: "json" | "text";
}

export interface InstallResult {
  output: string;
}

interface ExecuteContext {
  operation: string;
  browserStateUncertain?: boolean;
  allowNonzeroJson?: boolean;
}

function defaultLauncherPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "agent-browser", "bin", "agent-browser.js");
}

function diagnosticText(result: ExecResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `agent-browser exited with code ${String(result.code)}`).slice(0, 4_096);
}

function cancelledError(context: ExecuteContext) {
  if (!context.browserStateUncertain) {
    return browserError("browser_cancelled", `Pi interrupted agent-browser ${context.operation}`);
  }
  return browserError("browser_cancelled", "Pi interrupted the agent-browser client; browser-side completion is unknown. Snapshot before the next ref action.");
}

function browserRequestTimeout(request: EngineRequest): number {
  if (request.timeoutClass === "navigation") return LAUNCH_TIMEOUT_MS;
  if (request.timeoutClass === "wait") return WAIT_TIMEOUT_MS;
  return COMMAND_TIMEOUT_MS;
}

function parseJson(stdout: string, operation: string): EngineJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw browserError("browser_protocol_error", `${operation} returned malformed JSON; run package-local doctor and verify version ${AGENT_BROWSER_VERSION}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { success?: unknown }).success !== "boolean") {
    throw browserError("browser_protocol_error", `${operation} returned an invalid JSON result; run package-local doctor and verify version ${AGENT_BROWSER_VERSION}`);
  }
  return parsed as EngineJsonResult;
}

function parseJsonResult(stdout: string, operation: string): EngineJsonResult {
  const response = parseJson(stdout, operation);
  if (!response.success) {
    const reported = "error" in response && typeof response.error === "string" ? response.error : undefined;
    throw browserError("browser_upstream_error", reported ?? `${operation} failed`);
  }
  return response;
}

function isProtocolJsonResult(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout.trim());
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.success === "boolean");
  } catch {
    return false;
  }
}

function daemonSocketVanished(stdout: string): boolean {
  try {
    const response = JSON.parse(stdout.trim()) as { success?: unknown; error?: unknown };
    return response.success === false
      && typeof response.error === "string"
      && /^Failed to connect: No such file or directory \(os error 2\)$/.test(response.error);
  } catch {
    return false;
  }
}

function sandboxLaunchFailure(stdout: string): boolean {
  try {
    const response = JSON.parse(stdout.trim()) as { success?: unknown; error?: unknown };
    return response.success === false
      && typeof response.error === "string"
      && /No usable sandbox|--no-sandbox/.test(response.error);
  } catch {
    return false;
  }
}

export class AgentBrowserEngine {
  // Chrome cannot start its sandbox on hosts that block unprivileged user
  // namespaces (common in containers and VMs); once that failure is seen,
  // every later launch in this process needs --no-sandbox too.
  private sandboxUnavailable = false;

  constructor(
    private readonly exec: PiExecutor,
    readonly launcherPath = defaultLauncherPath(),
    private readonly runtimeExecutable = process.execPath,
    private readonly browserLaunchArgs: readonly string[] = [],
  ) {}

  private invocation(args: string[]): [string, string[]] {
    const runtimeName = this.runtimeExecutable.split(/[\\/]/).at(-1)?.toLowerCase();
    if (runtimeName === "node" || runtimeName === "node.exe" || runtimeName === "nodejs") {
      return [this.runtimeExecutable, [this.launcherPath, ...args]];
    }
    return [this.launcherPath, args];
  }

  private assertLauncher(): void {
    if (!existsSync(this.launcherPath)) {
      throw browserError(
        "browser_upstream_error",
        "package-local agent-browser launcher is missing; run npm ci in the extension directory, then /browser status",
      );
    }
  }

  private async execute(args: string[], options: ExecOptions, context: ExecuteContext): Promise<ExecResult> {
    this.assertLauncher();
    if (options.signal?.aborted) {
      throw cancelledError(context);
    }

    let result: ExecResult;
    try {
      const [command, commandArgs] = this.invocation(args);
      result = await this.exec(command, commandArgs, options);
    } catch (error) {
      if (options.signal?.aborted) {
        throw cancelledError(context);
      }
      throw browserError("browser_upstream_error", error instanceof Error ? error.message : String(error));
    }

    if (result.killed) {
      if (options.signal?.aborted) throw cancelledError(context);
      const uncertainty = context.browserStateUncertain
        ? "browser-side completion is unknown. Snapshot before the next ref action; "
        : "";
      throw browserError("browser_timeout", `${context.operation} timed out; ${uncertainty}run package-local doctor if the timeout repeats`);
    }
    result = { ...result, stderr: result.stderr.slice(0, MAX_DIAGNOSTIC_CHARS) };
    if (result.code !== 0 && (!context.allowNonzeroJson || !isProtocolJsonResult(result.stdout))) {
      throw browserError("browser_upstream_error", diagnosticText(result));
    }
    return result;
  }

  async version(signal?: AbortSignal): Promise<string> {
    const result = await this.execute(["--version"], { signal, timeout: DIAGNOSTIC_TIMEOUT_MS }, { operation: "version" });
    const match = result.stdout.trim().match(/(?:agent-browser\s+)?(\d+\.\d+\.\d+)/);
    if (!match) {
      throw browserError("browser_protocol_error", "agent-browser returned an invalid version response; run package-local doctor");
    }
    return match[1];
  }

  private launchArgs(): string[] {
    const args = [...this.browserLaunchArgs];
    if (this.sandboxUnavailable && !args.includes("--no-sandbox")) args.push("--no-sandbox");
    return args;
  }

  async run(request: EngineRequest, signal?: AbortSignal): Promise<EngineJsonResult> {
    const execute = () => {
      const globals = [
        "--session", request.session,
        "--json",
        "--content-boundaries",
        "--max-output", "50000",
      ];
      const launchArgs = this.launchArgs();
      if (launchArgs.length) globals.push("--args", launchArgs.join(","));
      if (request.profile) globals.push("--profile", request.profile);
      if (request.headed) globals.push("--headed");
      return this.execute([...globals, request.command, ...request.args], {
        signal,
        timeout: browserRequestTimeout(request),
        cwd: request.cwd,
      }, { operation: request.command, browserStateUncertain: true, allowNonzeroJson: true });
    };
    let result = await execute();
    if (request.responseFormat === "text") {
      if (result.code !== 0) {
        throw browserError("browser_upstream_error", `${request.command} help failed; run package-local doctor if the failure repeats`);
      }
      return { success: true, data: result.stdout };
    }
    if (request.command === "open" && daemonSocketVanished(result.stdout)) result = await execute();
    if (!this.sandboxUnavailable && sandboxLaunchFailure(result.stdout)) {
      this.sandboxUnavailable = true;
      result = await execute();
    }
    return parseJsonResult(result.stdout, request.command);
  }

  async close(session: string, signal?: AbortSignal, cwd?: string): Promise<void> {
    const result = await this.execute(["--session", session, "--json", "close"], {
      signal,
      timeout: SHUTDOWN_TIMEOUT_MS,
      cwd,
    }, { operation: "close", browserStateUncertain: true, allowNonzeroJson: true });
    parseJsonResult(result.stdout, "close");
  }

  async doctor(signal?: AbortSignal): Promise<EngineJsonResult> {
    const result = await this.execute(["doctor", "--offline", "--quick", "--json"], {
      signal,
      timeout: DIAGNOSTIC_TIMEOUT_MS,
    }, { operation: "doctor", allowNonzeroJson: true });
    return parseJson(result.stdout, "doctor");
  }

  async install(signal?: AbortSignal, withDeps = false): Promise<InstallResult> {
    const result = await this.execute(["install", ...(withDeps ? ["--with-deps"] : [])], {
      signal,
      timeout: INSTALL_TIMEOUT_MS,
    }, { operation: "install" });
    return { output: (result.stdout.trim() || "Browser installation completed").slice(0, 4_096) };
  }
}

export function browserInstalled(result: EngineJsonResult): boolean | undefined {
  const data = result.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const installed = (data as { browserInstalled?: unknown }).browserInstalled;
    if (typeof installed === "boolean") return installed;
  }
  const check = result.checks?.find((entry) => entry && typeof entry === "object" && entry.id === "chrome.installed");
  if (check?.status === "pass") return true;
  if (check?.status === "fail") return false;
  return undefined;
}
