# pi-browser

a browser extension for [pi](https://github.com/earendil-works/pi) on top of a pinned [agent-browser](https://www.npmjs.com/package/agent-browser). open pages, click, fill, and screenshot from the conversation. the agent-browser CLI is the vocabulary, and a bundled skill teaches it.

## why this exists

most browser packages for agents define their own tool surface, which then drifts from the automation engine underneath. i wanted the opposite: one generic tool, `browser_run`, that executes exactly one agent-browser command per call (`click @e2`, `snapshot -i -c`, `wait --load networkidle`). the vocabulary belongs to the CLI, and the pinned version is the contract.

a few typed tools exist for the things the generic path can't do safely: opening a URL with a named persistent profile, filling a secret from an environment variable without exposing its value, and capturing screenshots into a temporary store owned by the extension.

the boundary is small: pi owns the conversation, this extension owns session identity and lifecycle, and the agent-browser daemon owns the browser process.

## install

requires node 24+ and pi 0.84+, with `agent-browser` 0.37.1 and a chromium it can launch on `PATH`. the extension performs no cli installation or browser download: provision the supported cli and browser yourself, for example the `agent-browser` package from [numtide/llm-agents.nix](https://github.com/numtide/llm-agents.nix), which bundles chromium, or the npm package followed by its `install` command.

```sh
pi install git:github.com/chrishiguto/pi-browser
```

the source is unpinned, so `pi update --extensions` moves an installation to the current `main`. [chrishiguto/dotfiles](https://github.com/chrishiguto/dotfiles) consumes the package this way and refreshes it on `chezmoi apply`.

check `agent-browser --version` in your terminal and `/browser status` in pi. missing or incompatible executables produce a setup message. after repairing `PATH`, retry the operation without reloading pi.

`/browser status` checks cli compatibility without launching a browser. a successful `browser_open` verifies chromium launch. upstream `doctor` checks downloaded chrome caches and can report a missing browser even when a system-provided chromium works.

## use

| tool | job |
|------|-----|
| `browser_enable` | enable the browser tools for this session branch without launching anything |
| `browser_open` | open a URL and return an interactive compact snapshot with `@eN` refs |
| `browser_run` | run one pinned agent-browser command with literal args in the owned session |
| `browser_fill` | fill one input; `valueFromEnv` fills a secret without exposing its value |
| `browser_screenshot` | capture a screenshot into the extension-owned temporary artifact store |
| `browser_close` | close the owned browser while keeping the tools enabled |

pi also gets `/browser` for `on`, `off`, `status`, and the `headed [on|off]` preference.

the bundled `browser` skill teaches the workflow: open, run one command at a time through `browser_run`, re-snapshot after navigation or DOM changes, verify the rendered result, close. pass `--help` in args for any command's exact syntax.

login state and secrets:

- pass `profile: "<name>"` to `browser_open` to persist cookies and storage across browser and pi restarts; without a profile, state is ephemeral
- use `valueFromEnv` on `browser_fill` so a credential never passes through pi history
- for logins that should not pass through the model at all, open the page with `headed: true` and let the user complete the login under a named profile

## lifecycle

each pi session branch owns exactly one browser session, named deterministically from the working directory and session id, so parallel sessions and worktrees never collide.

the agent-browser daemon keeps the browser alive across pi reloads, and the replacement extension reattaches by its deterministic session name. on terminal shutdown the extension closes the owned browser under a deadline and cleans up its artifact store.

launches retry with `--no-sandbox` on hosts that block unprivileged user namespaces. `/browser status` reports the session, running mode, supported and installed cli versions, and whether this session has launched a browser.

## development

the entry point is `extensions/browser/index.ts`, declared in the `pi` manifest in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`check` is the typecheck plus every suite; `pnpm run test:unit`, `test:integration`, and `test:smoke` run one at a time. the integration and smoke suites need `agent-browser` and `pi` on `PATH`. ci runs the typecheck and unit suite in one bounded step, then the integration and smoke suites as separate bounded steps, on every push to `main` and every pull request, fetching both from the llm-agents.nix revision pinned in `.github/workflows/ci.yml`.
