import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, ...relativePath.split("/")), "utf8");
}

test("local JSON vs machine benchmark stays local-only and TS-only", () => {
  const source = readRepoFile("scripts/dx-local-json-vs-machine-benchmark.ts");
  const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts?: Record<string, string> };

  expect(packageJson.scripts?.["dx:bench:local-json-machine"]).toBe(
    "bun ./scripts/dx-local-json-vs-machine-benchmark.ts",
  );
  expect(source).toContain('schema: "dx.local_json_vs_machine_benchmark.v1"');
  expect(source).toContain('name: "local-json"');
  expect(source).toContain('name: "local-machine"');
  expect(source).toContain('BUN_DX_MACHINE_CACHE_DISABLE: "1"');
  expect(source).toContain("BUN_DX_MACHINE_CACHE_ROOT: caseRoot");
  expect(source).toContain("generationExcludedFromTiming: true");
  expect(source).toContain("processStartupExcludedFromTiming: true");
  expect(source).toContain('workerExtension: "ts"');
  expect(source).toContain("bench-worker.ts");
  expect(source).toContain('await import("./src/entry.ts")');
  expect(source).toContain("DX_LOCAL_BUN or a build/release-proof-* bun.exe is required");
  expect(source).toContain("Benchmark target must be the local Bun fork release-proof binary");
  expect(source).toContain("DX_LOCAL_MACHINE_BENCH_ALLOW_STALE_LOCAL_PROOF");
  expect(source).toContain("dx-local-json-vs-machine-benchmark-results.json");
  expect(source).not.toContain("official-json");
  expect(source).not.toContain("DX_OFFICIAL_BUN");
  expect(source).not.toContain(".mjs");
  expect(source).not.toContain(".cjs");
});

test("package-json machine proof records positive hits instead of silence", () => {
  const machineCache = readRepoFile("src/resolver/dx_machine_cache.rs");
  const packageJson = readRepoFile("src/resolver/package_json.rs");
  const resolver = readRepoFile("src/resolver/resolver.rs");

  expect(machineCache).toContain('const PROOF_LOG_ENV: &str = "BUN_DX_MACHINE_CACHE_PROOF_LOG";');
  expect(machineCache).toContain("pub fn record_package_json_machine_cache_proof(");
  expect(machineCache).toContain('"path_ref_read_some"');
  expect(machineCache).toContain('"path_owned_read_some"');
  expect(machineCache).toContain('"source_validation_read"');
  expect(machineCache).toContain('"packed_package_json_payload_hit"');
  expect(machineCache).toContain("OpenOptions::new().create(true).append(true)");
  expect(packageJson).toContain('"parse_attempt"');
  expect(packageJson).toContain('"machine_hit_path_ref"');
  expect(packageJson).toContain('"machine_hit_path_owned"');
  expect(packageJson).toContain('"normal_file_read"');
  expect(resolver).toContain("&& !info.is_inside_node_modules()");
});
