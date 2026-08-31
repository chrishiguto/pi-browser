---
name: browser
description: Use for interacting with or inspecting a rendered page, browser debugging, screenshots, browser automation, web search, or reusable login state. Route source-only refactors and code explanation to source tools.
---

# Browser workflow

Use the browser tools for any rendered work — local dev servers and external sites alike.

1. Call `browser_enable`, then `browser_open` with the URL. It returns an interactive compact snapshot; elements carry `@eN` refs.
2. Interact through the `browser_run` tool: one agent-browser command with literal args per call. Common commands:
   - `click @eN`, `type @eN <text>`, `press <key>` (e.g. `Enter`), `hover @eN`
   - `select @eN <option…>`, `check @eN`, `uncheck @eN`, `scroll down 500`
   - `wait <selector>`, `wait --text <text>`, `wait --url <pattern>`, `wait --load networkidle`
   - `snapshot -i -c` — fresh refs; run it after navigation, DOM changes, or a "ref not found" error, and pick a new ref rather than retrying the old one
   - `get text @eN`, `get title`, `get url`, `back`, `eval <js>`
   - Pass `--help` in args for a command's exact syntax; run `skills get core` for the full version-matched usage guide.
3. Use `browser_fill` to fill inputs; with `valueFromEnv` it fills a secret without the value passing through Pi history.
4. Use `browser_screenshot` only when visual inspection matters, then use Pi `read` on the returned temporary path.
5. Verify the expected rendered state in a fresh snapshot. Close with `browser_close` unless the user asked to keep the browser open.

## Login state and secrets

- To keep login state across browser and Pi restarts, pass `profile: "<name>"` to `browser_open`; the same named profile restores its cookies and storage next time. Without a profile, browser state is ephemeral.
- To fill a credential without placing its value in Pi history, export it before starting Pi and use `valueFromEnv: "VARIABLE_NAME"` on `browser_fill` instead of `value`.
- For logins that should not pass through the model at all, open the page with `headed: true` and let the user complete the login, using a named profile so it persists.

Complete only when the expected page or state was opened, each requested interaction succeeded, and the final rendered result was verified. For visual tasks, inspect the returned screenshot before completing, report its path, and leave it readable for the current Pi session.
