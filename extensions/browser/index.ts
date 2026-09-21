import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AgentBrowserEngine, AGENT_BROWSER_VERSION, BROWSER_SETUP } from "../../src/agent-browser.ts";
import { ArtifactStore } from "../../src/artifacts.ts";
import { BrowserController, BrowserProfiles, type BrowserEngine } from "../../src/browser.ts";
import { browserError } from "../../src/errors.ts";
import { BrowserState } from "../../src/state.ts";
import { registerBrowserTools } from "../../src/tools.ts";

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

const USAGE = `Usage:
/browser on
/browser off
/browser status
/browser headed [on|off]`;

export interface BrowserExtensionOptions {
  artifacts?: ArtifactStore;
  engine?: BrowserEngine;
  shutdownTimeoutMs?: number;
}

export function createBrowserExtension(options: BrowserExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => registerBrowserExtension(pi, options);
}

function registerBrowserExtension(pi: ExtensionAPI, options: BrowserExtensionOptions): void {
  const agentEngine = new AgentBrowserEngine(pi.exec.bind(pi));
  const engine = options.engine ?? agentEngine;
  const artifacts = options.artifacts ?? new ArtifactStore();
  const browser = new BrowserController(engine, undefined, artifacts, new BrowserProfiles());
  const state = new BrowserState();

  registerBrowserTools(pi, browser, state);
  registerBrowserCommand(pi, browser, agentEngine, artifacts, state);
  registerBrowserLifecycle(pi, browser, artifacts, state, options.shutdownTimeoutMs);
}

function registerBrowserLifecycle(
  pi: ExtensionAPI,
  browser: BrowserController,
  artifacts: ArtifactStore,
  state: BrowserState,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): void {
  const restoreState = (_event: unknown, ctx: { sessionManager: { getBranch(): unknown[] } }) => {
    state.restore(ctx.sessionManager.getBranch());
    state.reconcile(pi);
  };

  pi.on("session_start", restoreState);
  pi.on("session_tree", restoreState);
  pi.on("resources_discover", () => ({ skillPaths: [SKILLS_ROOT] }));
  pi.on("session_shutdown", async (event, ctx) => {
    browser.stopAccepting();
    // On reload the agent-browser daemon keeps the session alive; the
    // replacement extension reattaches by its deterministic session name.
    if (event.reason === "reload") return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(browserError("browser_timeout", "owned browser cleanup exceeded the shutdown deadline"));
      }, shutdownTimeoutMs);
    });
    let closeError: unknown;
    try {
      await Promise.race([browser.closeAll(controller.signal), timeout]);
    } catch (error) {
      closeError = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (closeError) {
      ctx.ui.notify(`Owned browser cleanup failed during ${event.reason}: ${String(closeError)}`, "warning");
    } else {
      await artifacts.cleanup();
    }
  });
}

function registerBrowserCommand(
  pi: ExtensionAPI,
  browser: BrowserController,
  engine: AgentBrowserEngine,
  artifacts: ArtifactStore,
  state: BrowserState,
): void {
  pi.registerCommand("browser", {
    description: "Manage the owned browser engine",
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim().split(/\s+/).filter(Boolean);

      if (args.length === 1 && args[0] === "on") {
        state.setEnabled(pi, true);
        ctx.ui.notify("Browser tools enabled; no browser launched.", "info");
        return;
      }

      if (args.length === 1 && args[0] === "off") {
        let closeError: unknown;
        try {
          await browser.closeAll(ctx.signal);
        } catch (error) {
          closeError = error;
        }
        state.setEnabled(pi, false);
        if (closeError) {
          ctx.ui.notify(`Browser tools disabled, but an owned browser close failed: ${String(closeError)}`, "warning");
        } else {
          ctx.ui.notify("Owned browser closed; browser tools disabled.", "info");
        }
        return;
      }

      if (args.length === 1 && args[0] === "status") {
        const owned = browser.status(ctx, state.headed);
        const lines = [
          "browser",
          `tools: ${state.enabled ? "enabled" : "disabled"}`,
          `session: ${owned.session}`,
          `headed preference: ${owned.headedPreference ? "on" : "off"}`,
          `running mode: ${owned.runningMode}`,
          ...(owned.profile ? [`profile: ${owned.profile}`] : []),
          `artifact root: ${artifacts.root}`,
          `supported cli: ${AGENT_BROWSER_VERSION}`,
          `executable: ${engine.executable}`,
        ];
        try {
          const version = await engine.checkCompatibility(ctx.signal);
          lines.push(`cli: ${version}`);
          lines.push(`browser: ${owned.isOpen ? "open" : "closed"}`);
          ctx.ui.notify(lines.join("\n"), "info");
        } catch (error) {
          lines.push(`diagnostics failed: ${String(error)}`, BROWSER_SETUP);
          ctx.ui.notify(lines.join("\n"), "warning");
        }
        return;
      }

      if ((args.length === 1 || args.length === 2) && args[0] === "headed") {
        if (args.length === 2 && (args[1] === "on" || args[1] === "off")) {
          state.setHeaded(pi, args[1] === "on");
          const owned = browser.status(ctx, state.headed);
          const relaunch = owned.isOpen && owned.headedPreference !== (owned.runningMode === "headed")
            ? " The next browser_open will require a fresh launch and lose ephemeral browser state."
            : "";
          ctx.ui.notify(`Headed preference: ${state.headed ? "on" : "off"}; running mode: ${owned.runningMode}.${relaunch}`, "info");
          return;
        }
        if (args.length === 1) {
          const owned = browser.status(ctx, state.headed);
          ctx.ui.notify(`Headed preference: ${state.headed ? "on" : "off"}; running mode: ${owned.runningMode}.`, "info");
          return;
        }
      }

      ctx.ui.notify(USAGE, "warning");
    },
  });
}

export default createBrowserExtension();
