import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentBrowserEngine } from "../../src/agent-browser.ts";
import { BrowserController } from "../../src/browser.ts";
import { startFixture } from "../fixture/server.ts";
import { nodeExecutor } from "../helpers/node-executor.ts";

const snapshot = { command: "snapshot", args: ["-i", "-c"] };

test("real browser completes routine commands and wait variants", { timeout: 60_000 }, async (t) => {
  const fixture = await startFixture();
  const engine = new AgentBrowserEngine(nodeExecutor, undefined, process.execPath, ["--no-sandbox"]);
  const browser = new BrowserController(engine);
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => `routine-actions-${process.pid}` },
  };
  t.after(async () => {
    await browser.close(undefined, ctx).catch(() => undefined);
    await fixture.close();
  });

  await browser.open({ url: fixture.url }, undefined, ctx);
  const firstSibling = browser.fill({ target: "#email", value: "first" }, undefined, ctx);
  const secondSibling = browser.command({ command: "type", args: ["#email", "-second"] }, undefined, ctx);
  await firstSibling;
  await secondSibling;
  const ordered = await browser.command(snapshot, undefined, ctx);
  assert.match(ordered.content[0].text, /first-second/);

  await browser.fill({ target: "#email", value: "person" }, undefined, ctx);
  await browser.command({ command: "type", args: ["#email", "@example.test"] }, undefined, ctx);
  const typed = await browser.command(snapshot, undefined, ctx);
  assert.match(typed.content[0].text, /person@example\.test/);

  await browser.command({ command: "check", args: ["#updates"] }, undefined, ctx);
  const checked = await browser.command(snapshot, undefined, ctx);
  assert.match(checked.content[0].text, /checked=true/);
  await browser.command({ command: "uncheck", args: ["#updates"] }, undefined, ctx);
  const unchecked = await browser.command(snapshot, undefined, ctx);
  assert.match(unchecked.content[0].text, /checked=false/);
  await browser.command({ command: "select", args: ["#plan", "pro"] }, undefined, ctx);
  const selected = await browser.command(snapshot, undefined, ctx);
  assert.match(selected.content[0].text, /option "Pro" \[selected/);
  await browser.command({ command: "select", args: ["#colors", "red", "blue"] }, undefined, ctx);
  const multi = await browser.command(snapshot, undefined, ctx);
  assert.match(multi.content[0].text, /option "Red" \[selected/);
  assert.match(multi.content[0].text, /option "Blue" \[selected/);

  await browser.command({ command: "hover", args: ["#reveal"] }, undefined, ctx);
  const hovered = await browser.command(snapshot, undefined, ctx);
  assert.match(hovered.content[0].text, /Revealed detail/);
  await browser.command({ command: "scroll", args: ["down", "2000"] }, undefined, ctx);
  await browser.command({ command: "wait", args: ["#scroll-result"] }, undefined, ctx);
  const scrollState = await browser.command(snapshot, undefined, ctx);
  assert.match(scrollState.content[0].text, /Scrolled viewport/);

  await browser.open({ url: fixture.url }, undefined, ctx);
  await browser.command({ command: "wait", args: ["#delayed-target"] }, undefined, ctx);
  const targetWait = await browser.command(snapshot, undefined, ctx);
  assert.match(targetWait.content[0].text, /Delayed target/);
  await browser.command({ command: "wait", args: ["--text", "Delayed text ready"] }, undefined, ctx);
  await browser.command({ command: "wait", args: ["--load", "domcontentloaded"] }, undefined, ctx);
  await browser.command({ command: "wait", args: ["1"] }, undefined, ctx);
  await browser.command({ command: "press", args: ["Escape"] }, undefined, ctx);

  await browser.command({ command: "click", args: ["#action"] }, undefined, ctx);
  const clicked = await browser.command(snapshot, undefined, ctx);
  assert.match(clicked.content[0].text, /Action completed/);
  await browser.fill({ target: "#email", value: "submit@example.test" }, undefined, ctx);
  await browser.command({ command: "focus", args: ["#email"] }, undefined, ctx);
  await browser.command({ command: "press", args: ["Enter"] }, undefined, ctx);
  const urlWait = await browser.command({ command: "wait", args: ["--url", "**/done*"] }, undefined, ctx);
  assert.match(urlWait.details.url ?? "", /\/done$/);
  const submitted = await browser.command(snapshot, undefined, ctx);
  assert.match(submitted.content[0].text, /Done/);
});

test("real stale ref requires a fresh snapshot and new ref", { timeout: 60_000 }, async (t) => {
  const fixture = await startFixture();
  const engine = new AgentBrowserEngine(nodeExecutor, undefined, process.execPath, ["--no-sandbox"]);
  const browser = new BrowserController(engine);
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => `stale-ref-${process.pid}` },
  };
  t.after(async () => {
    await browser.close(undefined, ctx).catch(() => undefined);
    await fixture.close();
  });

  const opened = await browser.open({ url: fixture.url }, undefined, ctx);
  const oldRef = opened.content[0].text.match(/button "Submit" \[ref=(e\d+)\]/)?.[1];
  assert.ok(oldRef);
  await browser.command({ command: "click", args: [`@${oldRef}`] }, undefined, ctx);
  await browser.command({ command: "wait", args: ["--url", "**/done*"] }, undefined, ctx);

  const fresh = await browser.command(snapshot, undefined, ctx);
  assert.doesNotMatch(fresh.content[0].text, /button "Submit"/);
  await assert.rejects(browser.command({ command: "click", args: [`@${oldRef}`] }, undefined, ctx), /Unknown ref|ref not found|not found/i);
  const freshRef = fresh.content[0].text.match(/link "Start over" \[ref=(e\d+)\]/)?.[1];
  assert.ok(freshRef);
  await browser.command({ command: "click", args: [`@${freshRef}`] }, undefined, ctx);
  const restarted = await browser.command(snapshot, undefined, ctx);
  assert.match(restarted.content[0].text, /Local browser fixture/);
});
