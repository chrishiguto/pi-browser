# pi-browser

a thin, self-contained browser extension for [pi](https://github.com/earendil-works/pi) over pinned [agent-browser](https://www.npmjs.com/package/agent-browser). open pages, click, fill, and screenshot from the conversation — the CLI's own vocabulary is the interface, taught by a bundled skill.

## why this exists

browser tooling for agents tends to grow a wide bespoke tool surface that drifts from the automation engine underneath. this package inverts that: one generic tool, `browser_run`, executes exactly one pinned agent-browser command per call (`click @e2`, `snapshot -i -c`, `wait --load networkidle`, …), so the vocabulary stays the CLI's and the pinned version is the contract.

a few typed tools cover only what the generic path can't express safely: opening a URL with a named persistent profile, filling a secret from an environment variable without exposing its value, and capturing screenshots into an extension-owned temporary store.

the boundary stays lean: pi manages the conversation, this extension owns session identity and lifecycle, and the agent-browser daemon owns the browser process.

## install

requires node 24+ and pi 0.84+. agent-browser `0.35.1` is a pinned package-local dependency.

install as a local pi package:

```
pi install /path/to/pi-browser
```

then, inside pi, install the package-local browser binary once:

```
/browser install [--with-deps]
```

## use

| tool | job |
|------|-----|
| `browser_enable` | enable the browser tools for this session branch without launching anything |
| `browser_open` | open a URL and return an interactive compact snapshot with `@eN` refs |
| `browser_run` | run one pinned agent-browser command with literal args in the owned session |
| `browser_fill` | fill one input; `valueFromEnv` fills a secret without exposing its value |
| `browser_screenshot` | capture a screenshot into the extension-owned temporary artifact store |
| `browser_close` | close the owned browser while keeping the tools enabled |

pi also gets `/browser` for `on`, `off`, `status`, `install [--with-deps]`, and the `headed [on|off]` preference.

the bundled `browser` skill teaches the workflow: open, interact through `browser_run` one command at a time, re-snapshot after navigation or DOM changes, verify the rendered result, close. pass `--help` in args for any command's exact syntax.

login state and secrets:

- pass `profile: "<name>"` to `browser_open` to persist cookies and storage across browser and pi restarts; without a profile, state is ephemeral
- use `valueFromEnv` on `browser_fill` so a credential never passes through pi history
- for logins that should not pass through the model at all, open the page with `headed: true` and let the user complete the login under a named profile

## lifecycle

each pi session branch owns exactly one browser session, named deterministically from the working directory and session id, so parallel sessions and worktrees never collide.

the agent-browser daemon keeps the browser alive across pi reloads; the replacement extension reattaches by its deterministic session name. on terminal shutdown the extension closes the owned browser under a deadline and cleans up its artifact store.

launches retry with `--no-sandbox` on hosts that block unprivileged user namespaces. `/browser status` reports the session, running mode, pinned and installed package versions, and whether the browser is ready.

## development

the canonical development source lives in this repository. the entry point is `extensions/browser/index.ts`, declared in the `pi` manifest in `package.json`.

```
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:smoke
npm test
```
