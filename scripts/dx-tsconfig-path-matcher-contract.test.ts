import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  filterTSConfigCacheEntries,
  precomputeTSConfigPathPatternEntries,
  matchTSConfigPathTargets,
  precomputeTSConfigPathPatterns,
} from "./dx-tsconfig-path-matcher-contract.ts";
import type { DxJsMachineCacheIndex } from "./dx-js-package-json-cache.ts";

test("matches exact tsconfig paths before wildcard paths", () => {
  const matcher = precomputeTSConfigPathPatterns({
    "pkg": ["exact/pkg.ts"],
    "pkg*": ["wildcard/*"],
  });

  expect(matchTSConfigPathTargets(matcher, "pkg")).toEqual(["exact/pkg.ts"]);
});

test("chooses the wildcard with the longest prefix and then longest suffix", () => {
  const matcher = precomputeTSConfigPathPatterns({
    "@/*": ["src/*"],
    "@/components/*": ["components/*"],
    "@/components/*.server": ["server/*"],
  });

  expect(matchTSConfigPathTargets(matcher, "@/components/Button.server")).toEqual(["server/Button"]);
});

test("preserves fallback target order and wildcard substitution", () => {
  const matcher = precomputeTSConfigPathPatterns({
    "lib/*": ["src/*", "generated/*/index", "fallback/static"],
  });

  expect(matchTSConfigPathTargets(matcher, "lib/a/b")).toEqual([
    "src/a/b",
    "generated/a/b/index",
    "fallback/static",
  ]);
  expect(matcher.patterns[0]?.targets).toEqual([
    {
      raw: "src/*",
      prefix: "src/",
      suffix: "",
      hasWildcard: true,
    },
    {
      raw: "generated/*/index",
      prefix: "generated/",
      suffix: "/index",
      hasWildcard: true,
    },
    {
      raw: "fallback/static",
      prefix: "fallback/static",
      suffix: "",
      hasWildcard: false,
    },
  ]);
});

test("rebuilds wildcard matcher from final paths map after duplicate keys", () => {
  const matcher = precomputeTSConfigPathPatternEntries([
    ["aa/*", ["old/*"]],
    ["bb/*", ["first/*"]],
    ["aa/*", ["new/*"]],
    ["bb/*", ["second/*"]],
  ]);

  expect(matchTSConfigPathTargets(matcher, "aa/value")).toEqual(["new/value"]);
  expect(matchTSConfigPathTargets(matcher, "bb/value")).toEqual(["second/value"]);
  expect(matcher.patterns.map((pattern) => pattern.key)).toEqual(["aa/*", "bb/*"]);
});

test("returns undefined when no tsconfig path pattern matches", () => {
  const matcher = precomputeTSConfigPathPatterns({
    "lib/*": ["src/*"],
  });

  expect(matchTSConfigPathTargets(matcher, "other/value")).toBeUndefined();
});

test("does not match overlapping tsconfig wildcard prefix and suffix", () => {
  const matcher = precomputeTSConfigPathPatterns({
    "foo*foo": ["x/*"],
  });

  expect(matchTSConfigPathTargets(matcher, "foo")).toBeUndefined();
});

test("filters tsconfig and jsconfig machine-cache entries", () => {
  const index: DxJsMachineCacheIndex = {
    schema: "dx.js.machine_cache_index.v1",
    generatedAtUtc: "2026-05-29T00:00:00.000Z",
    entries: [
      cacheEntry("package.json", "package_json"),
      cacheEntry("tsconfig.json", "tsconfig"),
      cacheEntry("nested\\jsconfig.json", "tsconfig"),
      cacheEntry("bunfig.toml", "bunfig"),
    ],
  };

  expect(filterTSConfigCacheEntries(index).map((entry) => entry.source)).toEqual([
    "tsconfig.json",
    "nested/jsconfig.json",
  ]);
});

test("keeps runner coverage for wildcard targets with empty suffixes", () => {
  const runTest = readFileSync(new URL("../test/cli/run/tsconfig-override.test.ts", import.meta.url), "utf8");

  expect(runTest).toContain("should resolve wildcard paths when wildcard target has no suffix");
  expect(runTest).toContain('"@target-empty/*": ["mapped/*"]');
  expect(runTest).toContain("target-empty-success");
  expect(runTest).toContain("BUN_DX_DISABLE_TSCONFIG_PRECOMPUTED_PATH_MATCHER");
});

test("keeps Rust tsconfig path targets precomputed before resolver matching", () => {
  const tsconfigJson = readFileSync(new URL("../src/resolver/tsconfig_json.rs", import.meta.url), "utf8");
  const resolver = readFileSync(new URL("../src/resolver/resolver.rs", import.meta.url), "utf8");

  expect(tsconfigJson).toContain("pub(crate) struct TSConfigPathTarget");
  expect(tsconfigJson).toContain("pub(crate) type PathTargets = SmallVec<[Box<[u8]>; 2]>");
  expect(tsconfigJson).toContain("pub(crate) type PathPatternTargets = SmallVec<[TSConfigPathTarget; 2]>");
  expect(tsconfigJson).toContain("pub(crate) type PathPatterns = SmallVec<[TSConfigPathPattern; 4]>");
  expect(tsconfigJson).toContain("pub has_wildcard: bool");
  expect(tsconfigJson).toContain("pub exact_path_min_len: u32");
  expect(tsconfigJson).toContain("pub exact_path_max_len: u32");
  expect(tsconfigJson).toContain("exact_path_min_len = exact_path_min_len.min(key_len)");
  expect(tsconfigJson).toContain("self.exact_path_max_len = exact_path_max_len");
  expect(tsconfigJson).toContain("path.len() < self.prefix.len() + self.suffix.len()");
  expect(tsconfigJson).toContain("fn rebuild_path_patterns(&mut self)");
  expect(tsconfigJson).toContain("TSConfigPathTarget::new(target.as_ref())");
  expect(tsconfigJson).toContain("result.rebuild_path_patterns();");
  expect(tsconfigJson).toContain("if self.path_patterns.len() > 1");
  expect(tsconfigJson).toContain("self.path_patterns.sort_by");
  expect(tsconfigJson).not.toContain("sort_unstable_by");
  expect(resolver).toContain("fn dx_disable_tsconfig_precomputed_path_matcher() -> bool");
  expect(resolver).toContain('std::env::var_os("BUN_DX_DISABLE_TSCONFIG_PRECOMPUTED_PATH_MATCHER").is_some()');
  expect(resolver).toContain("return self.match_tsconfig_paths_without_precomputed_patterns(");
  expect(resolver).toContain("fn match_tsconfig_paths_without_precomputed_patterns(");
  expect(resolver).toContain("for target in longest_match.targets.iter()");
  expect(resolver).toContain("can_match_exact_path && let Some(value) = tsconfig.paths.get(path)");
  expect(resolver).toContain("mc.exact_path_min_len = parent_config.exact_path_min_len");
  expect(resolver).toContain("if !target.has_wildcard");
  expect(resolver).toContain("let matched_text =");
  expect(resolver).toContain("let matched_text_segment = if target.suffix.is_empty()");
  expect(resolver).toContain("let matched_text_segment = if target_suffix.is_empty()");
  expect(resolver).toContain("matched_text_segment");
  expect(resolver).toContain("strings::index_of_char(original_path, b'*')");
  expect(resolver).not.toContain("strings::trim_left(&longest_match.suffix, b\"/\")");

  const putIndex = tsconfigJson.indexOf("let _ = result.paths.put(key, values);");
  const rebuildIndex = tsconfigJson.indexOf("result.rebuild_path_patterns();");
  expect(putIndex).toBeGreaterThan(-1);
  expect(rebuildIndex).toBeGreaterThan(putIndex);

  const exactMatchIndex = resolver.indexOf("if can_match_exact_path && let Some(value) = tsconfig.paths.get(path)");
  const disableIndex = resolver.indexOf("if dx_disable_tsconfig_precomputed_path_matcher() {");
  const precomputedWildcardIndex = resolver.indexOf("let longest_match = tsconfig");
  const staticTargetFastPathIndex = resolver.indexOf("if !target.has_wildcard");
  const wildcardTargetIndex = resolver.indexOf("let matched_text_segment = if target.suffix.is_empty()");
  expect(exactMatchIndex).toBeGreaterThan(-1);
  expect(disableIndex).toBeGreaterThan(exactMatchIndex);
  expect(precomputedWildcardIndex).toBeGreaterThan(disableIndex);
  expect(staticTargetFastPathIndex).toBeGreaterThan(precomputedWildcardIndex);
  expect(wildcardTargetIndex).toBeGreaterThan(staticTargetFastPathIndex);
});

function cacheEntry(source: string, kind: string) {
  return {
    source,
    kind,
    stem: source.replaceAll(/[\\/]/g, "-"),
    machine: `.dx/js/${source}.machine`,
    metadata: `.dx/js/${source}.machine.meta.json`,
    sourceBytes: 1,
    sourceModifiedUnixMs: 1,
    sourceBlake3: "source",
    machineBlake3: "machine",
    machineBytes: 1,
    metadataBytes: 1,
  };
}
