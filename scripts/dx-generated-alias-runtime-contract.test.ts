import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localBun = join(root, "build", "release", "bun.exe");
const fixture = join(root, ".tmp", "dx-generated-alias-runtime-contract");

function runLocalBun(args: string[], cwd = fixture) {
  const result = spawnSync(localBun, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

test("generated PHF alias tables stay wired to the hardcoded module source", () => {
  const buildScript = readFileSync(join(root, "src", "resolve_builtins", "build.rs"), "utf8");
  const hardcodedModule = readFileSync(join(root, "src", "resolve_builtins", "HardcodedModule.rs"), "utf8");

  expect(buildScript).toContain("write_alias_map(&mut generated, \"NODE_ALIAS_MAP\", &common)");
  expect(buildScript).toContain("write_alias_map(&mut generated, \"BUN_ALIAS_MAP\", &bun)");
  expect(buildScript).toContain("write_alias_map(&mut generated, \"BUN_TEST_ALIAS_MAP\", &bun_test)");
  expect(buildScript).toContain("clippy::disallowed_methods");
  expect(buildScript).toContain("failed to parse alias tuple");
  expect(buildScript).toContain("phf_codegen::Map::<&[u8]>::new()");
  expect(hardcodedModule).toContain("include!(concat!(env!(\"OUT_DIR\"), \"/hardcoded_aliases.rs\"));");
  expect(hardcodedModule).toContain("lookup(&NODE_ALIAS_MAP, name)");
  expect(hardcodedModule).toContain("lookup(&BUN_ALIAS_MAP, name)");
  expect(hardcodedModule).toContain("lookup(&BUN_TEST_ALIAS_MAP, name)");
});

test("local release resolves node, bun, and test-runner aliases at runtime", () => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });

  writeFileSync(
    join(fixture, "alias-runtime.ts"),
    `
import { readFileSync as bareRead } from "fs";
import { readFileSync as prefixedRead } from "node:fs";
import pathBare from "path";
import pathPrefixed from "node:path";
import { fileURLToPath } from "url";
import { argv } from "process";
console.log(JSON.stringify({
  fs: typeof bareRead === "function" && bareRead === prefixedRead,
  path: pathBare.sep === pathPrefixed.sep,
  url: fileURLToPath(import.meta.url).endsWith("alias-runtime.ts"),
  process: Array.isArray(argv),
}));
`,
  );

  const runtime = runLocalBun(["alias-runtime.ts"]);
  expect(runtime).toEqual({
    status: 0,
    stdout: JSON.stringify({ fs: true, path: true, url: true, process: true }),
    stderr: "",
  });

  writeFileSync(
    join(fixture, "vitest-alias.test.ts"),
    `
import { expect, test } from "vitest";
test("vitest alias routes to bun:test", () => {
  expect(21 * 2).toBe(42);
});
`,
  );
  writeFileSync(
    join(fixture, "jest-globals-alias.test.ts"),
    `
import { expect, test } from "@jest/globals";
test("@jest/globals alias routes to bun:test", () => {
  expect("alias".toUpperCase()).toBe("ALIAS");
});
`,
  );

  const testRun = runLocalBun(["test", "--timeout", "10000", "vitest-alias.test.ts", "jest-globals-alias.test.ts"]);
  expect(testRun.status).toBe(0);
  expect(testRun.stdout).toMatch(/bun test v\d+\.\d+\.\d+(?:-[^\s]+)?/);
  expect(testRun.stderr).toContain("2 pass");
  expect(testRun.stderr).toContain("0 fail");
});
