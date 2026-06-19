import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, ".tmp", "dx-release-test-runner-smoke");

function runTest(pattern: string) {
  return spawnSync(process.execPath, ["test", "--test-name-pattern", pattern, "nested-smoke.test.ts"], {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
}

test("release bun:test handles hooks, async tests, filtering, and expected failure exits", () => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  writeFileSync(
    join(fixture, "nested-smoke.test.ts"),
    `
import { afterAll, beforeAll, expect, test } from "bun:test";

let state = 0;
beforeAll(() => {
  state = 41;
});
afterAll(() => {
  state = 0;
});

test("async pass smoke", async () => {
  await Promise.resolve();
  expect(state + 1).toBe(42);
});

test("intentional failure smoke", () => {
  expect(1).toBe(2);
});
`,
  );

  const pass = runTest("async pass smoke");
  expect(pass.status).toBe(0);
  expect(`${pass.stdout}${pass.stderr}`).toContain("async pass smoke");
  expect(`${pass.stdout}${pass.stderr}`).not.toContain("intentional failure smoke");

  const fail = runTest("intentional failure smoke");
  expect(fail.status).not.toBe(0);
  expect(`${fail.stdout}${fail.stderr}`).toContain("intentional failure smoke");
});
