import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, ".tmp", "dx-release-package-manager-smoke");

function runBun(args: string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd: fixture,
    env: { ...process.env },
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("release Bun install handles offline file deps, lifecycle marker, bin shim, and stable lockfile", () => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(join(fixture, "packages", "tool"), { recursive: true });
  mkdirSync(join(fixture, "scripts"), { recursive: true });

  writeFileSync(
    join(fixture, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        name: "dx-release-package-manager-smoke",
        scripts: {
          postinstall: "bun ./scripts/postinstall.ts",
          "check-bin": "dx-release-tool",
        },
        dependencies: {
          "dx-release-tool": "file:./packages/tool",
        },
        trustedDependencies: ["dx-release-tool"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(fixture, "scripts", "postinstall.ts"), 'await Bun.write("postinstall.marker", "ran");\n');
  writeFileSync(
    join(fixture, "packages", "tool", "package.json"),
    `${JSON.stringify({ name: "dx-release-tool", version: "1.0.0", bin: { "dx-release-tool": "./bin.ts" } }, null, 2)}\n`,
  );
  writeFileSync(join(fixture, "packages", "tool", "bin.ts"), '#!/usr/bin/env bun\nconsole.log("bin-ok");\n');

  const install = runBun(["install", "--cache-dir", join(fixture, ".bun-cache")]);
  expect(install.status).toBe(0);
  expect(install.stderr).not.toContain("error:");
  expect(existsSync(join(fixture, "postinstall.marker"))).toBe(true);

  const lockfile = existsSync(join(fixture, "bun.lock")) ? join(fixture, "bun.lock") : join(fixture, "bun.lockb");
  expect(existsSync(lockfile)).toBe(true);
  const firstLockHash = createHash("sha256").update(readFileSync(lockfile)).digest("hex");

  const bin = runBun(["run", "check-bin"]);
  expect(bin.status).toBe(0);
  expect(bin.stdout).toContain("bin-ok");

  const reinstall = runBun(["install", "--cache-dir", join(fixture, ".bun-cache")]);
  expect(reinstall.status).toBe(0);
  expect(createHash("sha256").update(readFileSync(lockfile)).digest("hex")).toBe(firstLockHash);
});
