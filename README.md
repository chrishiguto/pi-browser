# pi-browser

a browser extension for [pi](https://github.com/earendil-works/pi) on top of a pinned [agent-browser](https://www.npmjs.com/package/agent-browser). open pages, click, fill, and screenshot from the conversation. the agent-browser CLI is the vocabulary, and a bundled skill teaches it.

## why this exists

most browser packages for agents define their own tool surface, which then drifts from the automation engine underneath. i wanted the opposite: one generic tool, `browser_run`, that executes exactly one agent-browser command per call (`click @e2`, `snapshot -i -c`, `wait --load networkidle`). the vocabulary belongs to the CLI, and the pinned version is the contract.

a few typed tools exist for the things the generic path can't do safely: opening a URL with a named persistent profile, filling a secret from an environment variable without exposing its value, and capturing screenshots into a temporary store owned by the extension.

the boundary is small: pi owns the conversation, this extension owns session identity and lifecycle, and the agent-browser daemon owns the browser process.

## workspace setup

requires node 24+ and pi 0.84+. agent-browser `0.37.1` and chromium come from the locked nix tools profile. the extension and your terminal both invoke `agent-browser` from `PATH`; nix owns installation and updates.

install the workspace dependencies from the dotfiles checkout root:

```sh
cd pi
pnpm install --frozen-lockfile
```

the managed Pi settings load `pi/packages/browser` directly from that checkout. editing the package and reloading Pi therefore uses the current source without a publication or standalone mirror step.

apply the dotfiles configuration with `chezmoi apply` to provision the tools profile, then check `agent-browser --version` in your terminal and `/browser status` in pi. the tools profile's `bin` directory must be on pi's `PATH`.

missing or incompatible executables produce a setup message. after repairing the profile, retry the operation without reloading pi. the extension performs no automatic cli installation or browser download. outside this dotfiles environment, provision the supported cli and a working browser yourself.

`/browser status` checks cli compatibility without launching a browser. a successful `browser_open` verifies chromium launch. upstream `doctor` checks downloaded chrome caches and can report a missing browser even when the nix-provided chromium works.

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
pnpm run typecheck
pnpm run test:unit
pnpm run test:integration
pnpm run test:smoke
pnpm test
```
