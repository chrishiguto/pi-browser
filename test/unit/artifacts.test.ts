import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ArtifactStore } from "../../src/artifacts.ts";

test("artifact store allocates collision-resistant owned paths", async (t) => {
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-artifact-test-"));
  t.after(() => rm(baseRoot, { recursive: true, force: true }));
  const store = new ArtifactStore({ baseRoot, pid: 123 });

  const first = await store.allocate();
  const second = await store.allocate(".txt");

  assert.ok(first.startsWith(join(baseRoot, "123")));
  assert.match(first, /\.png$/);
  assert.match(second, /\.txt$/);
  assert.notEqual(first, second);
  assert.ok((await stat(store.root)).isDirectory());
});

test("cleanup removes only this process's root and is idempotent", async (t) => {
  const baseRoot = await mkdtemp(join(tmpdir(), "pi-browser-artifact-test-"));
  t.after(() => rm(baseRoot, { recursive: true, force: true }));
  const first = new ArtifactStore({ baseRoot, pid: 101 });
  const second = new ArtifactStore({ baseRoot, pid: 202 });
  await writeFile(await first.allocate(), "one");
  const kept = await second.allocate();
  await writeFile(kept, "two");

  await first.cleanup();
  await first.cleanup();

  await assert.rejects(stat(first.root), { code: "ENOENT" });
  assert.equal((await stat(kept)).isFile(), true);
});
