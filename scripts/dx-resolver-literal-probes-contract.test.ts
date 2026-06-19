import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

test("resolver literal directory probes stay on prehashed map lookups", () => {
  const fsSource = readRepoFile("src/resolver/fs.rs");
  const resolverSource = readRepoFile("src/resolver/resolver.rs");
  const plan = readRepoFile("PLAN.md");

  expect(fsSource).toContain("const PREHASHED_PACKAGE_JSON_QUERY: u64");
  expect(fsSource).toContain("const PREHASHED_NODE_MODULES_QUERY: u64");
  expect(fsSource).toContain("const PREHASHED_DOT_BIN_QUERY: u64");
  expect(fsSource).toContain("const PREHASHED_TSCONFIG_JSON_QUERY: u64");
  expect(fsSource).toContain("const PREHASHED_JSCONFIG_JSON_QUERY: u64");
  expect(fsSource).toContain("fn prehashed_literal_query(query_lower: &'static [u8]) -> Option<u64>");
  expect(fsSource).toContain('b"package.json" => Some(PREHASHED_PACKAGE_JSON_QUERY)');
  expect(fsSource).toContain('b"node_modules" => Some(PREHASHED_NODE_MODULES_QUERY)');
  expect(fsSource).toContain('b".bin" => Some(PREHASHED_DOT_BIN_QUERY)');
  expect(fsSource).toContain('b"tsconfig.json" => Some(PREHASHED_TSCONFIG_JSON_QUERY)');
  expect(fsSource).toContain('b"jsconfig.json" => Some(PREHASHED_JSCONFIG_JSON_QUERY)');
  expect(fsSource).toContain("prehashed_literal_query(query_lower).unwrap_or_else(|| self.data.hash_key(query_lower))");
  expect(fsSource).toContain("self.data.get_hashed(query_hash, query_lower)");
  expect(fsSource).toContain("fn prehashed_literal_query_hashes_match_dir_entry_map_hasher()");

  expect(resolverSource).toContain('entries!().get_comptime_query(b"node_modules")');
  expect(resolverSource).toContain('entries!().has_comptime_query(b"node_modules")');
  expect(resolverSource).toContain('entries!().get_comptime_query(b".bin")');
  expect(resolverSource).toContain('entries!().get_comptime_query(b"package.json")');

  expect(plan).toContain("| 11 | Source-side/proven | Prehashed resolver literal probes are wired");
  expect(plan).toContain("`package.json`, `node_modules`, `.bin`, `tsconfig.json`, and `jsconfig.json`");
  expect(plan).toContain("the contract no longer permits hidden hashed fallbacks for those literals");
});

test("resolver compile-time literal probes are categorized", () => {
  const fsSource = readRepoFile("src/resolver/fs.rs");
  const resolverSource = readRepoFile("src/resolver/resolver.rs");
  const observedProbes = uniqueSorted(
    [...resolverSource.matchAll(/entries!\(\)\.(?:get|has)_comptime_query\(b"([^"]+)"\)/g)].map((match) => match[1]),
  );
  const prehashedProbes = new Set(
    [...fsSource.matchAll(/b"([^"]+)" => Some\(PREHASHED_[A-Z0-9_]+_QUERY\)/g)].map((match) => match[1]),
  );

  expect(observedProbes).toEqual([".bin", "jsconfig.json", "node_modules", "package.json", "tsconfig.json"]);

  for (const probe of observedProbes) {
    expect(prehashedProbes.has(probe)).toBe(true);
  }
});

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
