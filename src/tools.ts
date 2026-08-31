import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { BrowserController, ENVIRONMENT_VARIABLE_PATTERN_SOURCE, normalizeBrowserResult } from "./browser.ts";
import { physicalSessionName } from "./session.ts";
import { BrowserState, CURRENT_WORKING_TOOLS } from "./state.ts";

const emptyParameters = Type.Object({}, { additionalProperties: false });

export function registerBrowserTools(
  pi: ExtensionAPI,
  browser: BrowserController,
  state: BrowserState,
): void {
  pi.registerTool({
    name: "browser_enable",
    label: "Enable browser",
    description: "Enable the owned browser tools for this Pi session branch without launching a browser.",
    parameters: emptyParameters,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      state.setEnabled(pi, true);
      const session = physicalSessionName(ctx.cwd, ctx.sessionManager.getSessionId());
      return normalizeBrowserResult("browser_enable", session, { success: true }, {
        text: `Enabled browser tools: ${CURRENT_WORKING_TOOLS.join(", ")}`,
      });
    },
  });

  pi.registerTool({
    name: "browser_open",
    label: "Open page",
    description: "Open a URL in the owned browser and return an interactive compact snapshot with @eN element refs. Pass profile to persist login state across sessions.",
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
      headed: Type.Optional(Type.Boolean()),
      profile: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return browser.open({ ...params, headed: params.headed ?? state.headed }, signal, ctx);
    },
  });

  pi.registerTool({
    name: "browser_run",
    label: "Run browser command",
    description: "Run one pinned agent-browser command with literal arguments in the owned session. Common commands: snapshot -i -c (fresh @eN refs), click @eN, type @eN <text>, press <key>, select @eN <option>, scroll <direction> <px>, wait --text <text> | --load networkidle, get text @eN, back. Pass --help in args for a command's syntax.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      args: Type.Optional(Type.Array(Type.String())),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return browser.command(params, signal, ctx);
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Fill input",
    description: "Fill one input in the owned browser. Use valueFromEnv to fill a secret from an environment variable without exposing its value.",
    parameters: Type.Object({
      target: Type.String({ minLength: 1 }),
      value: Type.Optional(Type.String()),
      valueFromEnv: Type.Optional(Type.String({ pattern: ENVIRONMENT_VARIABLE_PATTERN_SOURCE })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return browser.fill(params, signal, ctx);
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Capture screenshot",
    description: "Capture a screenshot into the owned temporary artifact store.",
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean()),
      annotate: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return browser.screenshot(params, signal, ctx);
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Close browser",
    description: "Close the owned browser while keeping browser tools enabled.",
    parameters: emptyParameters,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      return browser.close(signal, ctx);
    },
  });
}
