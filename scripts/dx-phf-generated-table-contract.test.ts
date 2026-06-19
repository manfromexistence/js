import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildStaticLookupTable, lookupStaticEntry } from "./dx-phf-generated-table-contract.ts";

test("builds deterministic static lookup tables for generated PHF candidates", () => {
  const table = buildStaticLookupTable([
    { key: "node", value: "condition" },
    { key: "default", value: "condition" },
    { key: "import", value: "condition" },
  ]);

  expect(table.entries.map((entry) => entry.key)).toEqual(["default", "import", "node"]);
  expect(lookupStaticEntry(table, "import")).toEqual({ key: "import", value: "condition" });
});

test("normalizes node-prefixed builtin aliases before table generation", () => {
  const table = buildStaticLookupTable(
    [
      { key: "node:fs/promises", value: "fs.promises" },
      { key: "node:path", value: "path" },
    ],
    { stripNodePrefix: true },
  );

  expect(table.entries.map((entry) => entry.key)).toEqual(["fs/promises", "path"]);
  expect(lookupStaticEntry(table, "node:fs/promises")).toEqual({ key: "fs/promises", value: "fs.promises" });
});

test("rejects duplicate static keys after normalization", () => {
  expect(() =>
    buildStaticLookupTable(
      [
        { key: "fs", value: "fs" },
        { key: "node:fs", value: "fs" },
      ],
      { stripNodePrefix: true },
    ),
  ).toThrow("Duplicate static lookup key");
});

test("keeps default trusted dependencies generated as PHF map and hash set", () => {
  const buildScript = readFileSync(new URL("../src/install/build.rs", import.meta.url), "utf8");
  const lockfile = readFileSync(new URL("../src/install/lockfile.rs", import.meta.url), "utf8");
  const registryTest = readFileSync(new URL("../test/cli/install/bun-install-registry.test.ts", import.meta.url), "utf8");

  expect(buildScript).toContain("const MAX_DEFAULT_TRUSTED_DEPENDENCIES: usize = 512;");
  expect(buildScript).toContain("DEFAULT_TRUSTED_DEPENDENCIES: phf::Map<&'static [u8], u32>");
  expect(buildScript).toContain("DEFAULT_TRUSTED_DEPENDENCY_HASHES: phf::Set<u32>");
  expect(buildScript).toContain("Wyhash11::hash(0, name.as_bytes()) as u32");
  expect(buildScript).toContain("hashes.sort_unstable();");
  expect(buildScript).toContain("hashes.dedup();");
  expect(lockfile).toContain("include!(concat!(");
  expect(lockfile).toContain("env!(\"OUT_DIR\")");
  expect(lockfile).toContain("\"/default_trusted_dependencies_list.rs\"");
  expect(lockfile).toContain("pub mod default_trusted_dependencies");
  expect(lockfile).toContain("DEFAULT_TRUSTED_DEPENDENCIES.contains_key(name)");
  expect(lockfile).toContain("DEFAULT_TRUSTED_DEPENDENCY_HASHES.contains(&hash)");
  expect(registryTest).toContain('"pm", "default-trusted"');
  expect(registryTest).toContain("Default trusted dependencies");
});

test("keeps default trusted dependency source list sorted unique and capped", () => {
  const sourceList = readFileSync(new URL("../src/install/default-trusted-dependencies.txt", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  expect(sourceList.length).toBeGreaterThan(0);
  expect(sourceList.length).toBeLessThanOrEqual(512);
  expect(sourceList).toEqual([...sourceList].sort());
  expect(new Set(sourceList).size).toBe(sourceList.length);
});
