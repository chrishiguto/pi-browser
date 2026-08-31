import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBrowserExtension } from "../../extensions/browser/index.ts";
import { AgentBrowserEngine } from "../../src/agent-browser.ts";

// Test-only wiring bypasses this host's blocked user namespaces without
// weakening the production defaults.
export default function noSandboxBrowserExtension(pi: ExtensionAPI): void {
  const engine = new AgentBrowserEngine(
    pi.exec.bind(pi),
    undefined,
    process.execPath,
    ["--no-sandbox"],
  );
  createBrowserExtension({ engine })(pi);
  pi.registerCommand("browser-test-reload", {
    description: "Reload Pi during browser integration dogfood",
    handler: async (_args, ctx) => ctx.reload(),
  });
}
