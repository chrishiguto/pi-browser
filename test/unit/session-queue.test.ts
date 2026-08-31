import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionQueue } from "../../src/session.ts";

test("queue preserves submission order and remains usable after rejection", async () => {
  const queue = new SessionQueue();
  const events: string[] = [];
  const first = queue.run(async () => {
    events.push("first:start");
    await Promise.resolve();
    events.push("first:end");
    throw new Error("expected");
  });
  const second = queue.run(async () => {
    events.push("second");
    return 2;
  });

  await assert.rejects(first, /expected/);
  assert.equal(await second, 2);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});
