import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDirWithFiles } from "harness";
import path from "node:path";

describe("bun run --tsconfig-override", () => {
  test("should use custom tsconfig for path resolution", async () => {
    const dir = tempDirWithFiles("run-tsconfig-override", {
      "index.ts": `
        import { helper } from '@helpers/math';
        console.log(helper());
      `,
      "src/math.ts": `
        export function helper() {
          return "success from custom tsconfig";
        }
      `,
      "tsconfig.json": `
        {
          "compilerOptions": {
            "paths": {
              "@helpers/*": ["./wrong/*"]
            }
          }
        }
      `,
      "custom-tsconfig.json": `
        {
          "compilerOptions": {
            "paths": {
              "@helpers/*": ["./src/*"]
            }
          }
        }
      `,
    });

    await using failProc = Bun.spawn({
      cmd: [bunExe(), "run", path.join(dir, "index.ts")],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [failStderr, failExitCode] = await Promise.all([failProc.stderr.text(), failProc.exited]);

    expect(failStderr).toContain("Cannot find module");
    expect(failExitCode).not.toBe(0);

    await using successProc = Bun.spawn({
      cmd: [bunExe(), "run", "--tsconfig-override", path.join(dir, "custom-tsconfig.json"), path.join(dir, "index.ts")],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [successStdout, successStderr, successExitCode] = await Promise.all([
      successProc.stdout.text(),
      successProc.stderr.text(),
      successProc.exited,
    ]);

    expect(successStdout).toContain("success from custom tsconfig");

    if (!successStderr.includes("Internal error: directory mismatch")) {
      expect(successStderr).toBe("");
    }
    expect(successExitCode).toBe(0);
  });

  test("should work with relative tsconfig path", async () => {
    const dir = tempDirWithFiles("run-tsconfig-relative", {
      "src/main.ts": `
        import { lib } from '@lib/util';
        console.log(lib());
      `,
      "lib/util.ts": `
        export function lib() {
          return 42;
        }
      `,
      "config/custom.json": `
        {
          "compilerOptions": {
            "baseUrl": "../",
            "paths": {
              "@lib/*": ["lib/*"]
            }
          }
        }
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "run", "--tsconfig-override", "./config/custom.json", "./src/main.ts"],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stdout).toContain("42");

    if (!stderr.includes("Internal error: directory mismatch")) {
      expect(stderr).toBe("");
    }
    expect(exitCode).toBe(0);
  });

  test("should work with monorepo-style paths", async () => {
    const dir = tempDirWithFiles("run-tsconfig-monorepo", {
      "apps/web/src/index.ts": `
        import { Button } from '@ui/components';
        import { config } from '@shared/config';
        console.log('App loaded with', Button(), config);
      `,
      "packages/ui/components/index.ts": `
        export function Button() {
          return 'Button component';
        }
      `,
      "packages/shared/config.ts": `
        export const config = { name: 'monorepo-app' };
      `,
      "apps/web/tsconfig.json": `
        {
          "compilerOptions": {
            "baseUrl": "../../",
            "paths": {
              "@ui/*": ["packages/ui/*"],
              "@shared/*": ["packages/shared/*"]
            }
          }
        }
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "run", "--tsconfig-override", "./apps/web/tsconfig.json", "./apps/web/src/index.ts"],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stdout).toContain("Button component");
    expect(stdout).toContain("monorepo-app");

    if (!stderr.includes("Internal error: directory mismatch")) {
      expect(stderr).toBe("");
    }
    expect(exitCode).toBe(0);
  });

  test("should work with nested directories and complex paths", async () => {
    const dir = tempDirWithFiles("run-tsconfig-nested", {
      "frontend/src/pages/home.ts": `
        import { api } from '~/api/client';
        import { utils } from '#/utils/helpers';
        console.log(api.getHome(), utils.format('test'));
      `,
      "frontend/src/api/client.ts": `
        export const api = {
          getHome: () => 'home-data'
        };
      `,
      "frontend/src/utils/helpers.ts": `
        export const utils = {
          format: (str: string) => \`formatted-\${str}\`
        };
      `,
      "frontend/tsconfig.json": `
        {
          "compilerOptions": {
            "baseUrl": "./src",
            "paths": {
              "~/*": ["./*"],
              "#/*": ["./*"]
            }
          }
        }
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "run", "--tsconfig-override", "./frontend/tsconfig.json", "./frontend/src/pages/home.ts"],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stdout).toContain("home-data");
    expect(stdout).toContain("formatted-test");

    if (!stderr.includes("Internal error: directory mismatch")) {
      expect(stderr).toBe("");
    }
    expect(exitCode).toBe(0);
  });

  test("should handle extending tsconfig with overrides", async () => {
    const dir = tempDirWithFiles("run-tsconfig-extends", {
      "src/app.ts": `
        import { core } from '@core/main';
        import { feature } from '@features/auth';
        console.log('Loaded:', core, feature);
      `,
      "packages/core/main.ts": `
        export const core = 'core-module';
      `,
      "features/auth/index.ts": `
        export const feature = 'auth-feature';
      `,
      "tsconfig.base.json": `
        {
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {
              "@core/*": ["packages/core/*"]
            }
          }
        }
      `,
      "tsconfig.dev.json": `
        {
          "extends": "./tsconfig.base.json",
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {
              "@core/*": ["packages/core/*"],
              "@features/*": ["features/*"]
            }
          }
        }
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "run", "--tsconfig-override", "./tsconfig.dev.json", "./src/app.ts"],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stdout).toContain("core-module");
    expect(stdout).toContain("auth-feature");

    if (!stderr.includes("Internal error: directory mismatch")) {
      expect(stderr).toBe("");
    }
    expect(exitCode).toBe(0);
  });

  test("should resolve wildcard paths when precomputed matcher is disabled", async () => {
    const dir = tempDirWithFiles("run-tsconfig-precomputed-toggle", {
      "src/main.ts": `
        import { feature } from '@feature/auth';
        console.log(feature);
      `,
      "features/auth.ts": `
        export const feature = 'success';
      `,
      "tsconfig.json": `
        {
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {
              "@feature/*": ["features/*"]
            }
          }
        }
      `,
    });

    async function runWithEnv(env: typeof bunEnv) {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "run", "--tsconfig-override", "./tsconfig.json", "./src/main.ts"],
        env,
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout).toContain("success");
      if (!stderr.includes("Internal error: directory mismatch")) {
        expect(stderr).toBe("");
      }
      expect(exitCode).toBe(0);
    }

    await runWithEnv(bunEnv);
    await runWithEnv({ ...bunEnv, BUN_DX_DISABLE_TSCONFIG_PRECOMPUTED_PATH_MATCHER: "1" });
  });

  test("should resolve wildcard paths when wildcard target has no suffix", async () => {
    const dir = tempDirWithFiles("run-tsconfig-target-empty-suffix", {
      "src/main.ts": `
        import { marker } from '@target-empty/nested/value';
        console.log(marker);
      `,
      "mapped/nested/value.ts": `
        export const marker = 'target-empty-success';
      `,
      "mapped/nested/value/index.ts": `
        export const marker = 'wrong-extra-segment';
      `,
      "tsconfig.json": `
        {
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {
              "@target-empty/*": ["mapped/*"]
            }
          }
        }
      `,
    });

    async function runWithEnv(env: typeof bunEnv) {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "run", "--tsconfig-override", "./tsconfig.json", "./src/main.ts"],
        env,
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout).toContain("target-empty-success");
      expect(stdout).not.toContain("wrong-extra-segment");
      if (!stderr.includes("Internal error: directory mismatch")) {
        expect(stderr).toBe("");
      }
      expect(exitCode).toBe(0);
    }

    await runWithEnv(bunEnv);
    await runWithEnv({ ...bunEnv, BUN_DX_DISABLE_TSCONFIG_PRECOMPUTED_PATH_MATCHER: "1" });
  });

  test("should resolve wildcard paths with key and target suffixes when precomputed matcher is disabled", async () => {
    const dir = tempDirWithFiles("run-tsconfig-precomputed-suffix-toggle", {
      "src/main.ts": `
        import { feature } from '@feature/auth/view';
        import { exact } from '@pkg/exact';
        import { longest } from '@pkg/admin.view';
        import { fallback } from '@fallback/tool';
        import { staticTarget } from '@static/anything';
        console.log(JSON.stringify({ feature, exact, longest, fallback, staticTarget }));
      `,
      "features/auth/index.ts": `
        export const feature = 'suffix-success';
      `,
      "exact/file.ts": `
        export const exact = 'exact-success';
      `,
      "wildcard/exact.ts": `
        export const exact = 'wrong-wildcard-exact';
      `,
      "views/admin/view.ts": `
        export const longest = 'longest-suffix-success';
      `,
      "views/admin.ts": `
        export const longest = 'wrong-shorter-suffix';
      `,
      "fallbacks/second/tool.ts": `
        export const fallback = 'fallback-success';
      `,
      "fallbacks/static.ts": `
        export const staticTarget = 'static-success';
      `,
      "tsconfig.json": `
        {
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {
              "@feature/*/view": ["features/*/index"],
              "@pkg/exact": ["exact/file"],
              "@pkg/*": ["wildcard/*"],
              "@pkg/*.view": ["views/*/view"],
              "@fallback/*": ["missing/*", "fallbacks/second/*"],
              "@static/*": ["fallbacks/static"]
            }
          }
        }
      `,
    });

    async function runWithEnv(env: typeof bunEnv) {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "run", "--tsconfig-override", "./tsconfig.json", "./src/main.ts"],
        env,
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(JSON.parse(stdout)).toEqual({
        feature: "suffix-success",
        exact: "exact-success",
        longest: "longest-suffix-success",
        fallback: "fallback-success",
        staticTarget: "static-success",
      });
      if (!stderr.includes("Internal error: directory mismatch")) {
        expect(stderr).toBe("");
      }
      expect(exitCode).toBe(0);
    }

    await runWithEnv(bunEnv);
    await runWithEnv({ ...bunEnv, BUN_DX_DISABLE_TSCONFIG_PRECOMPUTED_PATH_MATCHER: "1" });
  });

  test("should preserve exact-miss and longest-wildcard tsconfig fallback boundaries", async () => {
    const dir = tempDirWithFiles("run-tsconfig-fallback-boundaries", {
      "src/main.ts": `
        import { exactFallback } from '@exact/fallback';

        let longestStatus = 'unexpected';
        try {
          const mod = await import('@choice/specific/tool');
          longestStatus = mod.shorter ?? 'resolved';
        } catch {
          longestStatus = 'not-found';
        }

        console.log(JSON.stringify({ exactFallback, longestStatus }));
      `,
      "wildcard/fallback.ts": `
        export const exactFallback = 'wildcard-after-exact-miss';
      `,
      "shorter/specific/tool.ts": `
        export const shorter = 'wrong-shorter-fallback';
      `,
      "tsconfig.json": `
        {
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {
              "@exact/fallback": ["missing/exact"],
              "@exact/*": ["wildcard/*"],
              "@choice/specific/*": ["missing-specific/*"],
              "@choice/*": ["shorter/*"]
            }
          }
        }
      `,
    });

    async function runWithEnv(env: typeof bunEnv) {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "run", "--tsconfig-override", "./tsconfig.json", "./src/main.ts"],
        env,
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(JSON.parse(stdout)).toEqual({
        exactFallback: "wildcard-after-exact-miss",
        longestStatus: "not-found",
      });
      if (!stderr.includes("Internal error: directory mismatch")) {
        expect(stderr).toBe("");
      }
      expect(exitCode).toBe(0);
    }

    await runWithEnv(bunEnv);
    await runWithEnv({ ...bunEnv, BUN_DX_DISABLE_TSCONFIG_PRECOMPUTED_PATH_MATCHER: "1" });
  });

  test("should work from different working directories", async () => {
    const dir = tempDirWithFiles("run-tsconfig-cwd", {
      "project/src/main.ts": `
        import { helper } from '@utils/math';
        console.log('Result:', helper(5, 3));
      `,
      "project/utils/math.ts": `
        export function helper(a: number, b: number) {
          return a + b;
        }
      `,
      "project/tsconfig.json": `
        {
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {
              "@utils/*": ["utils/*"]
            }
          }
        }
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "run", "--tsconfig-override", "project/tsconfig.json", "project/src/main.ts"],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stdout).toContain("Result: 8");

    if (!stderr.includes("Internal error: directory mismatch")) {
      expect(stderr).toBe("");
    }
    expect(exitCode).toBe(0);
  });
});
