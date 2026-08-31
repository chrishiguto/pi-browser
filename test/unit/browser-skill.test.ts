import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("browser skill documents the tool workflow, profiles, and secret-filling guidance", async () => {
  const skillRoot = join(process.cwd(), "skills", "browser");
  const main = await readFile(join(skillRoot, "SKILL.md"), "utf8");

  assert.match(main, /^description: .*inspecting a rendered page.*screenshots/m);
  assert.match(main, /browser_enable.*browser_open/s);
  assert.match(main, /`@eN` refs/);
  assert.match(main, /snapshot -i -c/);
  assert.match(main, /ref not found.*new ref rather than retrying/is);
  assert.match(main, /skills get core/);
  assert.match(main, /profile: "<name>".*cookies and storage/is);
  assert.match(main, /valueFromEnv: "VARIABLE_NAME"/);
  assert.match(main, /headed: true.*let the user complete the login/is);
  assert.doesNotMatch(main, /isolated|trusted-profile|--browser-unrestricted|env trust|policy/);
});
