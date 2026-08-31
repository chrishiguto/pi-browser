import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { EngineJsonResult, EngineRequest } from "./agent-browser.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { BrowserError, browserError } from "./errors.ts";
import { BrowserSessions, validateIdentitySegment, type OwnedSession, type SessionIdentityContext } from "./session.ts";

export interface BrowserEngine {
  run(request: EngineRequest, signal?: AbortSignal): Promise<EngineJsonResult>;
  close(session: string, signal?: AbortSignal, cwd?: string): Promise<void>;
}

// --- environment-backed values -------------------------------------------

export const ENVIRONMENT_VARIABLE_PATTERN_SOURCE = "^[A-Z_][A-Z0-9_]*$";
const ENVIRONMENT_VARIABLE_PATTERN = new RegExp(ENVIRONMENT_VARIABLE_PATTERN_SOURCE);

function validateEnvironmentVariableName(value: unknown): string {
  if (typeof value !== "string" || !ENVIRONMENT_VARIABLE_PATTERN.test(value)) {
    throw browserError("browser_invalid_input", "valueFromEnv must match [A-Z_][A-Z0-9_]*");
  }
  return value;
}

function resolveEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw browserError("browser_invalid_input", `environment variable ${name} is not set`);
  }
  return value;
}

// --- result normalization -------------------------------------------------

// Upstream --max-output bounds real payloads; this is a final guard against
// JSON fields the flag does not cover.
const MAX_TEXT_CHARS = 60_000;

export interface BrowserResultDetails {
  operation: string;
  actor: string;
  session: string;
  valueFromEnv?: string;
  url?: string;
  title?: string;
  artifact?: {
    kind: string;
    path: string;
  };
  changedPage?: boolean;
  snapshotIncluded?: boolean;
  alreadyClosed?: boolean;
}

export interface BrowserToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: BrowserResultDetails;
}

export interface ResultOverrides {
  actor?: string;
  valueFromEnv?: string;
  text?: string;
  url?: string;
  title?: string;
  changedPage?: boolean;
  snapshotIncluded?: boolean;
  alreadyClosed?: boolean;
  artifact?: {
    kind: string;
    path: string;
  };
}

function dataRecord(result: EngineJsonResult): Record<string, unknown> {
  return result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : {};
}

function dataString(result: EngineJsonResult, field: string): string | undefined {
  const value = dataRecord(result)[field];
  return typeof value === "string" ? value : undefined;
}

export function normalizeBrowserResult(
  operation: string,
  session: string,
  result: EngineJsonResult,
  overrides: ResultOverrides = {},
): BrowserToolResult {
  const text = overrides.text ?? dataString(result, "snapshot") ?? dataString(result, "message") ?? "Done";
  const url = overrides.url ?? dataString(result, "url") ?? dataString(result, "origin");
  const title = overrides.title ?? dataString(result, "title");

  return {
    content: [{ type: "text", text: text.slice(0, MAX_TEXT_CHARS) }],
    details: {
      operation,
      actor: overrides.actor ?? "main",
      session,
      ...(overrides.valueFromEnv ? { valueFromEnv: overrides.valueFromEnv } : {}),
      ...(url ? { url } : {}),
      ...(title ? { title } : {}),
      ...(overrides.artifact ? { artifact: overrides.artifact } : {}),
      ...(overrides.changedPage !== undefined ? { changedPage: overrides.changedPage } : {}),
      ...(overrides.snapshotIncluded !== undefined ? { snapshotIncluded: overrides.snapshotIncluded } : {}),
      ...(overrides.alreadyClosed !== undefined ? { alreadyClosed: overrides.alreadyClosed } : {}),
    },
  };
}

// --- generic command planning ---------------------------------------------

export interface CommandParams {
  command: string;
  args?: string[];
}

export interface CommandPlan {
  command: string;
  args: string[];
  responseFormat: "json" | "text";
}

// Flags the extension supplies itself; caller-provided copies would detach the
// command from the owned session or break the JSON protocol contract.
const MANAGED_GLOBALS = new Set([
  "--session",
  "--namespace",
  "--json",
  "--max-output",
  "--content-boundaries",
  "--no-content-boundaries",
  "--profile",
]);

const CLOSE_COMMANDS = new Set(["close", "exit", "quit"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function buildCommandPlan(params: CommandParams): CommandPlan {
  if (!isRecord(params)) throw browserError("browser_invalid_input", "command parameters must be an object");
  const unknown = Object.keys(params).filter((field) => !["command", "args"].includes(field));
  if (unknown.length) throw browserError("browser_invalid_input", `command forbids ${unknown.join(", ")}`);
  if (
    typeof params.command !== "string"
    || params.command.length === 0
    || params.command.trim() !== params.command
    || /[\s/\\\0]/u.test(params.command)
    || params.command.startsWith("-")
    || params.command === "agent-browser"
  ) {
    throw browserError("browser_invalid_input", "command must be one upstream top-level command token, not a flag or executable path");
  }
  if (params.args !== undefined && (!Array.isArray(params.args) || params.args.some((arg) => typeof arg !== "string"))) {
    throw browserError("browser_invalid_input", "command args must be an array of literal strings");
  }
  const args = params.args ? [...params.args] : [];
  const managed = args.find((arg) => MANAGED_GLOBALS.has(arg.split("=", 1)[0]!));
  if (managed) {
    throw browserError("browser_invalid_input", `${managed.split("=", 1)[0]} is extension-managed and cannot be supplied by browser_run`);
  }
  if (CLOSE_COMMANDS.has(params.command) && args.some((arg) => arg.split("=", 1)[0] === "--all")) {
    throw browserError("browser_invalid_input", "closing all sessions would escape the extension-owned session");
  }
  return {
    command: params.command,
    args,
    responseFormat: args.includes("--help") || args.includes("-h") ? "text" : "json",
  };
}

export function formatCommandResult(result: EngineJsonResult): string {
  const payload = Object.fromEntries(Object.entries(result).filter(([key, value]) => (
    key !== "success"
    && key !== "_boundary"
    && value !== undefined
    && !(key === "error" && value === null)
  )));
  const keys = Object.keys(payload);
  if (keys.length === 0) return "Done";
  if (keys.length === 1 && keys[0] === "data") {
    if (typeof payload.data === "string") return payload.data;
    return JSON.stringify(payload.data, null, 2);
  }
  return JSON.stringify(payload, null, 2);
}

// --- controller -----------------------------------------------------------

export interface OpenParams {
  url: string;
  headed?: boolean;
  profile?: string;
}

export interface FillParams {
  target: string;
  value?: string;
  valueFromEnv?: string;
}

export interface ScreenshotParams {
  fullPage?: boolean;
  annotate?: boolean;
}

export class BrowserProfiles {
  readonly root: string;

  constructor(root?: string) {
    this.root = resolve(root ?? join(homedir(), ".pi", "agent", "browser", "profiles"));
  }

  async resolve(name: string): Promise<string> {
    validateIdentitySegment("profile", name);
    const path = join(this.root, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }
}

function validateScreenshotParams(params: ScreenshotParams): void {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw browserError("browser_invalid_input", "screenshot parameters must be an object");
  }
  const unknown = Object.keys(params).filter((field) => field !== "fullPage" && field !== "annotate");
  if (unknown.length) throw browserError("browser_invalid_input", `screenshot forbids ${unknown.join(", ")}; the output path is extension-owned`);
  if (params.fullPage !== undefined && typeof params.fullPage !== "boolean") throw browserError("browser_invalid_input", "fullPage must be boolean when supplied");
  if (params.annotate !== undefined && typeof params.annotate !== "boolean") throw browserError("browser_invalid_input", "annotate must be boolean when supplied");
}

function validateFillParams(params: FillParams): void {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw browserError("browser_invalid_input", "fill parameters must be an object");
  }
  if (typeof params.target !== "string" || params.target.trim() === "") {
    throw browserError("browser_invalid_input", "target must be a nonempty string");
  }
  if ((params.value === undefined) === (params.valueFromEnv === undefined)) {
    throw browserError("browser_invalid_input", "fill requires exactly one of value or valueFromEnv");
  }
  if (params.value !== undefined && typeof params.value !== "string") {
    throw browserError("browser_invalid_input", "value must be a string");
  }
  if (params.valueFromEnv !== undefined) validateEnvironmentVariableName(params.valueFromEnv);
}

export class BrowserController {
  private readonly sessions: BrowserSessions;
  private accepting = true;

  constructor(
    private readonly engine: BrowserEngine,
    sessions?: BrowserSessions,
    private readonly artifacts?: ArtifactStore,
    private readonly profiles = new BrowserProfiles(),
  ) {
    this.sessions = sessions ?? new BrowserSessions((session, signal) => (
      this.engine.close(session.physicalName, signal, session.cwd)
    ));
  }

  status(ctx: SessionIdentityContext, headedPreference = false) {
    const session = this.sessions.resolve(ctx);
    return {
      session: session.physicalName,
      isOpen: session.isOpen,
      headedPreference,
      runningMode: session.isOpen ? (session.headed ? "headed" : "headless") : "closed",
      profile: session.profile,
    };
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  private assertAccepting(): void {
    if (!this.accepting) throw browserError("browser_cancelled", "browser extension is shutting down; retry after the Pi session transition");
  }

  private normalizeResult(
    operation: string,
    session: OwnedSession,
    result: EngineJsonResult,
    overrides: ResultOverrides = {},
  ): BrowserToolResult {
    return normalizeBrowserResult(operation, session.physicalName, result, { actor: session.actor, ...overrides });
  }

  private engineOptions(session: OwnedSession): Pick<EngineRequest, "profile"> {
    return session.profilePath ? { profile: session.profilePath } : {};
  }

  private async abandonSession(session: OwnedSession): Promise<void> {
    await this.sessions.closeResolved(session, undefined, true).catch(() => undefined);
  }

  async open(params: OpenParams, signal: AbortSignal | undefined, ctx: SessionIdentityContext): Promise<BrowserToolResult> {
    this.assertAccepting();
    let url: URL;
    try {
      url = new URL(params.url);
    } catch {
      throw browserError("browser_invalid_input", "url must be a valid absolute URL");
    }
    const session = this.sessions.resolve(ctx);
    const headed = params.headed ?? false;

    return session.queue.run(async () => {
      const profile = params.profile;
      const profilePath = profile === undefined ? undefined : await this.profiles.resolve(profile);
      const mustRelaunch = (session.isOpen || session.engineCleanupRequired) && (
        session.headed !== headed || session.profile !== profile
      );
      if (mustRelaunch) {
        await this.sessions.closeResolved(session, signal);
      }
      session.profile = profile;
      session.profilePath = profilePath;

      let opened: EngineJsonResult;
      try {
        opened = await this.engine.run({
          session: session.physicalName,
          cwd: ctx.cwd,
          command: "open",
          args: [url.href],
          timeoutClass: "navigation",
          headed,
          ...this.engineOptions(session),
        }, signal);
      } catch (error) {
        await this.abandonSession(session);
        if (headed && error instanceof BrowserError && error.code === "browser_upstream_error") {
          throw browserError("browser_upstream_error", `${error.message}; retry with browser_open headed false or /browser headed off`);
        }
        throw error;
      }
      session.isOpen = true;
      session.headed = headed;

      const snapshot = await this.engine.run({
        session: session.physicalName,
        cwd: ctx.cwd,
        command: "snapshot",
        args: ["-i", "-c"],
        ...this.engineOptions(session),
      }, signal);
      const openedUrl = dataString(snapshot, "url") ?? dataString(snapshot, "origin") ?? dataString(opened, "url") ?? url.href;
      const openedTitle = dataString(snapshot, "title") ?? dataString(opened, "title");
      return this.normalizeResult("browser_open", session, snapshot, {
        url: openedUrl,
        ...(openedTitle ? { title: openedTitle } : {}),
        changedPage: true,
        snapshotIncluded: true,
        ...(mustRelaunch ? {
          text: [
            "Browser relaunched; ephemeral state was lost.",
            dataString(snapshot, "snapshot") ?? "",
          ].join("\n"),
        } : {}),
      });
    });
  }

  async fill(params: FillParams, signal: AbortSignal | undefined, ctx: SessionIdentityContext): Promise<BrowserToolResult> {
    this.assertAccepting();
    validateFillParams(params);
    const session = this.sessions.resolve(ctx);
    return session.queue.run(async () => {
      session.engineCleanupRequired = true;
      const value = params.valueFromEnv ? resolveEnvironmentValue(params.valueFromEnv) : params.value!;
      const result = await this.engine.run({
        session: session.physicalName,
        cwd: ctx.cwd,
        command: "fill",
        args: [params.target, value],
        ...this.engineOptions(session),
      }, signal);
      return this.normalizeResult("browser_fill", session, result, {
        ...(params.valueFromEnv ? { valueFromEnv: params.valueFromEnv } : {}),
      });
    });
  }

  async screenshot(params: ScreenshotParams, signal: AbortSignal | undefined, ctx: SessionIdentityContext): Promise<BrowserToolResult> {
    this.assertAccepting();
    validateScreenshotParams(params);
    const session = this.sessions.resolve(ctx);
    return session.queue.run(async () => {
      if (!this.artifacts) throw browserError("browser_upstream_error", "artifact store is unavailable; reload the Pi session");
      session.engineCleanupRequired = true;
      const path = await this.artifacts.allocate(".png");
      const args = [
        ...(params.fullPage ? ["--full"] : []),
        ...(params.annotate ? ["--annotate"] : []),
        path,
      ];
      await this.engine.run({
        session: session.physicalName,
        cwd: ctx.cwd,
        command: "screenshot",
        args,
        ...this.engineOptions(session),
      }, signal);
      return this.normalizeResult("browser_screenshot", session, { success: true }, {
        text: `Screenshot captured: ${path}`,
        artifact: { kind: "screenshot", path },
      });
    });
  }

  async command(params: CommandParams, signal: AbortSignal | undefined, ctx: SessionIdentityContext): Promise<BrowserToolResult> {
    this.assertAccepting();
    const plan = buildCommandPlan(params);
    const session = this.sessions.resolve(ctx);
    return session.queue.run(async () => {
      session.engineCleanupRequired = true;
      const result = await this.engine.run({
        session: session.physicalName,
        cwd: ctx.cwd,
        command: plan.command,
        args: plan.args,
        responseFormat: plan.responseFormat,
        ...(plan.command === "wait" ? { timeoutClass: "wait" as const } : {}),
        ...(plan.command === "open" || plan.command === "navigate" ? { timeoutClass: "navigation" as const } : {}),
        ...this.engineOptions(session),
      }, signal);
      if (CLOSE_COMMANDS.has(plan.command) && plan.responseFormat === "json") {
        this.sessions.reconcileClosed(session);
      }
      return this.normalizeResult("browser_command", session, result, {
        text: dataString(result, "snapshot") ?? dataString(result, "message") ?? formatCommandResult(result),
      });
    });
  }

  async close(signal: AbortSignal | undefined, ctx: SessionIdentityContext): Promise<BrowserToolResult> {
    this.assertAccepting();
    const session = this.sessions.resolve(ctx);
    return session.queue.run(async () => {
      const alreadyClosed = await this.sessions.closeResolved(session, signal);
      return this.normalizeResult("browser_close", session, { success: true }, {
        text: alreadyClosed ? "Browser is already closed." : "Browser closed.",
        alreadyClosed,
      });
    });
  }

  async closeAll(signal?: AbortSignal): Promise<void> {
    await this.sessions.closeAll(signal);
  }
}
