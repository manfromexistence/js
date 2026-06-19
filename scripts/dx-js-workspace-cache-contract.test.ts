import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DxJsMachineCacheIndex } from "./dx-js-package-json-cache.ts";
import {
  filterBunfigCacheEntries,
  filterWorkspacePackageCacheEntries,
  planWorkspacePackageInputs,
} from "./dx-js-workspace-cache-contract.ts";

test("plans workspace package inputs with deterministic bounded glob expansion", () => {
  const plan = planWorkspacePackageInputs(
    ["packages/*", "recursive/**", "single-package"],
    [
      "packages/pkg-b",
      "packages/node_modules",
      "packages/pkg-a",
      "packages/CMakeFiles",
      "packages/pkg-c/nested",
    ],
    { maxWorkspacePackages: 1 },
  );

  expect(plan.inputs).toEqual(["packages/pkg-a/package.json", "single-package/package.json"]);
  expect(plan.skippedRecursivePatterns).toEqual(["recursive/**"]);
  expect(plan.maxParallelJobs).toBe(1);
});

test("deduplicates overlapping workspace package patterns case-insensitively", () => {
  const plan = planWorkspacePackageInputs(
    ["packages/*", "packages/pkg-a", "packages\\PKG-A"],
    ["packages/pkg-a", "packages/pkg-b"],
  );

  expect(plan.inputs).toEqual(["packages/pkg-a/package.json", "packages/pkg-b/package.json"]);
});

test("filters workspace package sidecars without including the root package", () => {
  const index = cacheIndex([
    cacheEntry("package.json", "package_json"),
    cacheEntry("packages\\pkg-a\\package.json", "package_json"),
    cacheEntry("single-package/package.json", "package_json"),
    cacheEntry("tsconfig.json", "tsconfig"),
  ]);

  expect(filterWorkspacePackageCacheEntries(index).map((entry) => entry.source)).toEqual([
    "packages/pkg-a/package.json",
    "single-package/package.json",
  ]);
});

test("filters only real bunfig sidecars from generic TOML cache entries", () => {
  const index = cacheIndex([
    cacheEntry("bunfig.toml", "bunfig"),
    cacheEntry("nested\\bunfig.node-test.toml", "bunfig"),
    cacheEntry("other.toml", "bunfig"),
    cacheEntry("package.json", "package_json"),
  ]);

  expect(filterBunfigCacheEntries(index).map((entry) => entry.source)).toEqual([
    "bunfig.toml",
    "nested/bunfig.node-test.toml",
  ]);
});

test("keeps workspace package cache on safe single-probe prehashed lookups", () => {
  const workspaceCache = readFileSync(
    new URL("../src/install/PackageManager/WorkspacePackageJSONCache.rs", import.meta.url),
    "utf8",
  );
  const arrayHashMap = readFileSync(new URL("../src/collections/array_hash_map.rs", import.meta.url), "utf8");

  expect(arrayHashMap).toContain("pub fn get_or_try_insert_hashed<E>");
  expect(arrayHashMap).toContain("RawEntryMut::Occupied(entry) => Ok(entry.into_mut())");
  expect(arrayHashMap).toContain("RawEntryMut::Vacant(entry)");
  expect(workspaceCache).toContain("let path_hash = self.map.hash_key(path);");
  expect(workspaceCache).toContain("self.map.get_or_try_insert_hashed(path_hash, path");
  expect(workspaceCache).not.toContain("cached_entry_ptr");
  expect(workspaceCache).not.toContain("unsafe { &mut *entry }");
});

function cacheIndex(entries: DxJsMachineCacheIndex["entries"]): DxJsMachineCacheIndex {
  return {
    schema: "dx.js.machine_cache_index.v1",
    generatedAtUtc: "2026-05-29T00:00:00.000Z",
    entries,
  };
}

function cacheEntry(source: string, kind: string): DxJsMachineCacheIndex["entries"][number] {
  const stem = source.replaceAll(/[\\/]/g, "-");

  return {
    source,
    kind,
    stem,
    machine: `.dx/js/${stem}.machine`,
    metadata: `.dx/js/${stem}.machine.meta.json`,
    sourceBytes: 1,
    sourceModifiedUnixMs: 1,
    sourceBlake3: "source",
    machineBlake3: "machine",
    machineBytes: 1,
    metadataBytes: 1,
  };
}
