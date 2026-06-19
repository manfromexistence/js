import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, ".tmp", "dx-release-bundler-compile-smoke");

test("release Bun builds, minifies, emits sourcemaps, and compiles a tiny executable", async () => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(join(fixture, "src"), { recursive: true });
  const outdir = join(fixture, "dist");

  writeFileSync(join(fixture, "src", "style.css"), ".answer { color: red; }\n");
  writeFileSync(
    join(fixture, "src", "entry.ts"),
    'import "./style.css";\nconst value: number = 40 + 2;\nconsole.log("bundle:" + value);\n',
  );

  const result = await Bun.build({
    entrypoints: [join(fixture, "src", "entry.ts")],
    outdir,
    target: "bun",
    minify: true,
    sourcemap: "external",
  });
  expect(result.success).toBe(true);
  const builtFiles = readdirSync(outdir);
  const builtJs = builtFiles.find((name) => name.endsWith(".js"));
  expect(builtJs).toBeDefined();
  expect(builtFiles.some((name) => name.endsWith(".js.map"))).toBe(true);
  expect(builtFiles.some((name) => name.endsWith(".css"))).toBe(true);

  const runBundle = spawnSync(process.execPath, [join(outdir, builtJs!)], {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
  });
  expect(runBundle.status).toBe(0);
  expect(runBundle.stdout.trim()).toBe("bundle:42");

  writeFileSync(join(fixture, "compile-entry.ts"), 'console.log("compiled:" + (21 * 2));\n');
  const compiledExe = join(fixture, "compiled-smoke.exe");
  const compile = spawnSync(process.execPath, ["build", join(fixture, "compile-entry.ts"), "--compile", "--outfile", compiledExe], {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  expect(compile.status).toBe(0);
  expect(existsSync(compiledExe)).toBe(true);

  const runCompiled = spawnSync(compiledExe, [], {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  expect(runCompiled.status).toBe(0);
  expect(runCompiled.stdout.trim()).toBe("compiled:42");
});
