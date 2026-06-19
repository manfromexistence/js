import { expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const buildScript = join(repoRoot, "scripts", "build.ts");
const textDecoder = new TextDecoder();

test("build script help exits before configure or Windows VS shell setup", () => {
  const env = { ...process.env };
  delete env.VSINSTALLDIR;

  const result = Bun.spawnSync({
    cmd: [process.execPath, buildScript, "--help"],
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = textDecoder.decode(result.stdout) + textDecoder.decode(result.stderr);

  expect(result.exitCode).toBe(0);
  expect(output).toContain("Usage: bun scripts/build.ts");
  expect(output).toContain("--profile=<name>");
  expect(output).not.toContain("ReferenceError");
  expect(output).not.toContain("Cannot access 'USAGE'");
  expect(output).not.toContain("Loading Visual Studio environment");
  expect(output).not.toContain("Developer PowerShell");
});
