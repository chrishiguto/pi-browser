import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { browserError } from "./errors.ts";

export function validateIdentitySegment(kind: "actor" | "profile", value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9_-]{1,32}$/.test(value)) {
    throw browserError("browser_invalid_input", `${kind} must be 1-32 lowercase letters, numbers, underscores, or hyphens`);
  }
}

function shortIdentityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function canonicalProjectPath(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

export function physicalSessionName(project: string, piSessionId: string, actor = "main"): string {
  validateIdentitySegment("actor", actor);
  return `pi-browser-${shortIdentityHash(canonicalProjectPath(project))}-${shortIdentityHash(piSessionId)}-${shortIdentityHash(actor)}`;
}

// Pi issues parallel tool calls but a page is not concurrent-safe; every
// operation on one session runs through this single-flight queue.
export class SessionQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface OwnedSession {
  actor: string;
  physicalName: string;
  cwd: string;
  queue: SessionQueue;
  isOpen: boolean;
  headed: boolean;
  profile?: string;
  profilePath?: string;
  engineCleanupRequired: boolean;
}

export interface SessionIdentityContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
  actor?: string;
}

export type SessionCloser = (session: OwnedSession, signal?: AbortSignal) => Promise<void>;

export class BrowserSessions {
  private readonly sessions = new Map<string, OwnedSession>();

  constructor(private readonly closer: SessionCloser) {}

  resolve(ctx: SessionIdentityContext): OwnedSession {
    const actor = ctx.actor ?? "main";
    const physicalName = physicalSessionName(ctx.cwd, ctx.sessionManager.getSessionId(), actor);
    let session = this.sessions.get(physicalName);
    if (!session) {
      session = {
        actor,
        physicalName,
        cwd: ctx.cwd,
        queue: new SessionQueue(),
        isOpen: false,
        headed: false,
        engineCleanupRequired: false,
      };
      this.sessions.set(physicalName, session);
    }
    return session;
  }

  async closeResolved(session: OwnedSession, signal?: AbortSignal, force = false): Promise<boolean> {
    const alreadyClosed = !session.isOpen && !session.engineCleanupRequired;
    if (!alreadyClosed || force) await this.closer(session, signal);
    this.reconcileClosed(session);
    return alreadyClosed;
  }

  reconcileClosed(session: OwnedSession): void {
    session.engineCleanupRequired = false;
    session.isOpen = false;
    session.profile = undefined;
    session.profilePath = undefined;
  }

  async closeAll(signal?: AbortSignal): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((session) => (
        session.queue.run(() => this.closeResolved(session, signal))
      )),
    );
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
