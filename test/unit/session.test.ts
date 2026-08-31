import assert from "node:assert/strict";
import { test } from "node:test";

import { physicalSessionName } from "../../src/session.ts";

test("physical session names are deterministic, hashed, and input-specific", () => {
  const first = physicalSessionName("/projects/secret-name", "session-a", "main");
  assert.equal(first, physicalSessionName("/projects/secret-name", "session-a", "main"));
  assert.notEqual(first, physicalSessionName("/projects/other", "session-a", "main"));
  assert.notEqual(first, physicalSessionName("/projects/secret-name", "session-b", "main"));
  assert.doesNotMatch(first, /secret-name|session-a/);
  assert.match(first, /^pi-browser-[a-f0-9]+-[a-f0-9]+-[a-f0-9]+$/);
});

test("physical session identity rejects an invalid logical actor before hashing", () => {
  assert.throws(
    () => physicalSessionName("/project", "session", "../../other-profile"),
    /browser_invalid_input:.*actor must be 1-32 lowercase/i,
  );
});

