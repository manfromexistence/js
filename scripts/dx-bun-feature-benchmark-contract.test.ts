import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const benchmarkPath = join(repoRoot, "scripts", "dx-bun-feature-benchmark.ts");
const benchmarkSource = readFileSync(benchmarkPath, "utf8");

test("feature benchmark stays wired to package scripts and proof modes", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  expect(packageJson.scripts?.["dx:bench:features"]).toBe("bun ./scripts/dx-bun-feature-benchmark.ts");

  const modes = [...benchmarkSource.matchAll(/case "([^"]+)":/g)].map((match) => match[1]);
  expect(new Set(modes).size).toBe(modes.length);
  expect(modes).toEqual([
    "official-vs-local",
    "binary-ab",
    "same-local-ab",
    "same-local-aa",
    "same-local-libdeflate",
    "same-local-libdeflate-pool",
    "same-local-tsconfig-precomputed",
    "same-local-char-frequency-simd",
    "same-local-resolver-conditions-inline",
    "same-local-which",
    "same-local-exports-index",
  ]);

  expect(benchmarkSource).toContain("DX_FEATURE_BENCH_BASELINE_BUN");
  expect(benchmarkSource).toContain("DX_FEATURE_BENCH_CANDIDATE_BUN");
  expect(benchmarkSource).toContain("DX_FEATURE_BENCH_BASELINE_LABEL");
  expect(benchmarkSource).toContain("DX_FEATURE_BENCH_CANDIDATE_LABEL");
  expect(benchmarkSource).toContain("same-binary-aa");
  expect(benchmarkSource).toContain("same-binary-noise-floor");
  expect(benchmarkSource).toContain("indirect(?:ly)?");
  expect(benchmarkSource).toContain("BUN_DX_DISABLE_EXPORTS_EXACT_KEY_INDEX");
  expect(benchmarkSource).toContain("BUN_DX_DISABLE_RESOLVER_INLINE_CONDITIONS_MAP");
  expect(benchmarkSource).toContain("BUN_DX_DISABLE_WHICH_BIN_UTF16_REUSE");
  expect(benchmarkSource).toContain("BUN_DX_DISABLE_LIBDEFLATE_EXTRACT_POOL");
  expect(benchmarkSource).toContain("BUN_DX_DISABLE_TSCONFIG_PRECOMPUTED_PATH_MATCHER");
  expect(benchmarkSource).toContain("BUN_DX_DISABLE_SIMD_CHAR_FREQUENCY");
  expect(benchmarkSource).toContain("BUN_FEATURE_FLAG_NO_LIBDEFLATE");
});

test("feature benchmark row evidence references known scenario rows", () => {
  const scenarioRows = parseScenarioRows();
  const evidence = parseRowEvidence();

  expect(evidence.size).toBe(30);
  for (const [row, scenarios] of evidence) {
    expect(row).toBeGreaterThanOrEqual(1);
    expect(row).toBeLessThanOrEqual(30);
    for (const scenario of scenarios) {
      expect(scenarioRows.has(scenario)).toBe(true);
      expect(scenarioRows.get(scenario)).toContain(row);
    }
  }
});

test("feature benchmark coverage shape stays honest", () => {
  const evidence = parseRowEvidenceDetails();
  const sourceOnlyRows: number[] = [];
  const directRows: number[] = [];
  const indirectRows: number[] = [];

  for (const [row, item] of evidence) {
    if (item.scenarios.length === 0) {
      sourceOnlyRows.push(row);
    } else if (/\bindirect(?:ly)?\b|source-proven|source evidence|applies pressure|runtime pressure/i.test(item.note)) {
      indirectRows.push(row);
    } else {
      directRows.push(row);
    }
  }

  expect(directRows).toEqual([7, 8, 9, 13, 14, 19, 21, 22, 26, 28]);
  expect(indirectRows).toEqual([6, 10, 12, 15, 20, 23, 24, 25, 27]);
  expect(sourceOnlyRows).toEqual([1, 2, 3, 4, 5, 11, 16, 17, 18, 29, 30]);
});

test("feature benchmark keeps which-path fixture measurable and path-normalized", () => {
  const whichSection = functionBody("prepareWhichPathResolution");

  expect(benchmarkSource).toContain('const whichPathIterations = positiveIntegerEnv("DX_FEATURE_BENCH_WHICH_ITERATIONS", 2000)');
  expect(whichSection).toContain("const iterations = whichPathIterations");
  expect(whichSection).toContain("const normalizePath = (value: string)");
  expect(whichSection).toContain('value.replaceAll("/",');
  expect(whichSection).toContain("normalizePath(found) !== normalizePath(expected)");
  expect(whichSection).toContain("for (let i = 0; i < ${iterations}; i += 1)");
});

test("feature benchmark checkpoints each completed scenario before continuing", () => {
  const loopStart = benchmarkSource.indexOf("for (const scenario of prepared) {");
  expect(loopStart).toBeGreaterThanOrEqual(0);
  const loopEnd = benchmarkSource.indexOf("\nconst summary", loopStart);
  expect(loopEnd).toBeGreaterThan(loopStart);
  const loopSection = benchmarkSource.slice(loopStart, loopEnd);

  expect(benchmarkSource).toContain("function buildBenchmarkSummary(results: ScenarioResult[]): BenchmarkSummary");
  expect(loopSection).toContain("console.log(`[dx-bench] starting ${scenario.name}");
  expect(loopSection).toContain("writeBenchmarkOutputs(buildBenchmarkSummary(results))");
  expect(loopSection).toContain("console.log(`[dx-bench] completed ${scenario.name}");
});

test("feature benchmark bounds child processes and writes failure artifacts", () => {
  const runAndReadSection = functionDeclaration("runAndRead");
  const timedSpawnSection = functionDeclaration("timedSpawn");
  const failureWriter = functionDeclaration("writeBenchmarkFailureOutputs");
  const loopStart = benchmarkSource.indexOf("for (const scenario of prepared) {");
  const loopEnd = benchmarkSource.indexOf("\nconst summary", loopStart);
  const loopSection = benchmarkSource.slice(loopStart, loopEnd);

  expect(benchmarkSource).toContain('const spawnTimeoutMs = positiveIntegerEnv("DX_FEATURE_BENCH_SPAWN_TIMEOUT_MS", 120000)');
  expect(runAndReadSection).toContain("timeout: spawnTimeoutMs");
  expect(runAndReadSection).toContain("formatSpawnFailure");
  expect(timedSpawnSection).toContain("timeout: spawnTimeoutMs");
  expect(timedSpawnSection).toContain("formatSpawnFailure");
  expect(loopSection).toContain("writeBenchmarkFailureOutputs(scenario, error, buildBenchmarkSummary(results))");
  expect(failureWriter).toContain('writeFileSync(join(workRoot, "failure-latest.json")');
  expect(failureWriter).toContain('writeFileSync(join(workRoot, "failure.md")');
  expect(failureWriter).toContain('writeFileSync(join(snapshotRoot, `failure-${slug}.json`)');
  expect(failureWriter).toContain('writeFileSync(join(snapshotRoot, `failure-${slug}.md`)');
});

test("feature benchmark fixtures keep intended resolver and tsconfig pressure", () => {
  const resolverSection = functionBody("prepareResolverExportsImports");
  const resolverExactSection = functionBody("prepareResolverExactIndex");
  const resolverWildcardSection = functionBody("prepareResolverWildcardConditions");
  const tsconfigSection = functionBody("prepareTsconfigPaths");
  const tsconfigExactSection = functionBody("prepareTsconfigExactPaths");
  const tsconfigWildcardSection = functionBody("prepareTsconfigWildcardPaths");
  const tsconfigFallbackSection = functionBody("prepareTsconfigFallbackPaths");

  expect(parseNumberConst(resolverSection, "exactImportCount")).toBeGreaterThanOrEqual(128);
  expect(parseNumberConst(resolverSection, "exactExportCount")).toBeGreaterThanOrEqual(128);
  expect(parseNumberConst(resolverSection, "wildcardFeatureCount")).toBeGreaterThanOrEqual(32);
  expect(resolverSection).toContain('exportsMap["./feature/*"]');
  expect(resolverSection).toContain('imports[`#tool/${i}`]');
  expect(resolverSection).toContain('Array.from({ length: exactExportCount }');
  expect(resolverSection).toContain('Array.from({ length: exactImportCount }');

  expect(parseNumberConst(resolverExactSection, "exactImportCount")).toBeGreaterThanOrEqual(128);
  expect(parseNumberConst(resolverExactSection, "exactExportCount")).toBeGreaterThanOrEqual(128);
  expect(resolverExactSection).toContain('"resolver-exact-index-heavy"');

  expect(parseNumberConst(resolverWildcardSection, "wildcardFeatureCount")).toBeGreaterThanOrEqual(96);
  expect(parseNumberConst(resolverWildcardSection, "conditionKeyCount")).toBeGreaterThanOrEqual(12);
  expect(resolverWildcardSection).toContain('"resolver-wildcard-conditions-heavy"');
  expect(resolverWildcardSection).toContain('target[`dx-condition-${i}`]');

  const groupCount = parseNumberConst(tsconfigSection, "groupCount");
  const modulesPerGroup = parseNumberConst(tsconfigSection, "modulesPerGroup");
  expect(groupCount).toBeGreaterThanOrEqual(12);
  expect(modulesPerGroup).toBeGreaterThanOrEqual(24);
  expect(groupCount * modulesPerGroup).toBeGreaterThanOrEqual(288);
  expect(tsconfigSection).toContain('paths[`@lib${group}/*`]');
  expect(tsconfigSection).toContain('import exact from "@exact";');

  expect(parseNumberConst(tsconfigExactSection, "exactPathCount")).toBeGreaterThanOrEqual(128);
  expect(tsconfigExactSection).toContain('paths[`@exact${i}`]');
  expect(tsconfigExactSection).toContain('"tsconfig-paths-exact-runtime"');

  const wildcardGroupCount = parseNumberConst(tsconfigWildcardSection, "groupCount");
  const wildcardModulesPerGroup = parseNumberConst(tsconfigWildcardSection, "modulesPerGroup");
  expect(wildcardGroupCount * wildcardModulesPerGroup).toBeGreaterThanOrEqual(288);
  expect(tsconfigWildcardSection).toContain('paths[`@wild${group}/*`]');
  expect(tsconfigWildcardSection).toContain('"tsconfig-paths-wildcard-runtime"');

  const fallbackGroupCount = parseNumberConst(tsconfigFallbackSection, "groupCount");
  const fallbackModulesPerGroup = parseNumberConst(tsconfigFallbackSection, "modulesPerGroup");
  expect(fallbackGroupCount * fallbackModulesPerGroup).toBeGreaterThanOrEqual(200);
  expect(tsconfigFallbackSection).toContain('src/missing-${group}/*.ts');
  expect(tsconfigFallbackSection).toContain('src/fallback-${group}/*.ts');
  expect(tsconfigFallbackSection).toContain('"tsconfig-paths-fallback-runtime"');
});

test("feature benchmark strips ambient Bun env case-insensitively before applying overrides", () => {
  const section = functionDeclaration("sanitizedBenchmarkEnv");
  const deleteIndex = section.indexOf("delete env[key]");
  const assignIndex = section.indexOf("Object.assign(env, overrides)");

  expect(section).toContain('key.toUpperCase().startsWith("BUN_")');
  expect(deleteIndex).toBeGreaterThanOrEqual(0);
  expect(assignIndex).toBeGreaterThan(deleteIndex);
});

test("feature benchmark reports underpowered, noisy, and unstable deltas as unranked", () => {
  const rankableFormatter = functionDeclaration("formatRankableDelta");
  const deltaBuilder = functionDeclaration("buildDeltas");
  const classifier = functionDeclaration("classifyDelta");
  const consoleSummary = functionDeclaration("renderConsoleSummary");
  const markdownSummary = functionDeclaration("renderMarkdownSummary");

  expect(benchmarkSource).toContain('type BenchmarkSignal = "signal" | "noisy" | "unstable" | "underpowered"');
  expect(benchmarkSource).toContain("const minRankableRuns = 20");
  expect(benchmarkSource).toContain("const comparison = buildComparisonSummary(targets)");
  expect(benchmarkSource).toContain("deltas: buildDeltas(results, targets, comparison)");
  expect(deltaBuilder).toContain("comparison: ReturnType<typeof buildComparisonSummary>");
  expect(deltaBuilder).toContain("classifyDelta(baseline, candidate, candidateFasterPct, comparison)");
  expect(classifier).toContain("Math.min(baseline.runs, candidate.runs) < minRankableRuns");
  expect(classifier).toContain('return "underpowered"');
  expect(classifier).toContain('comparison.kind === "same-binary-aa"');
  expect(classifier).toContain('return "noisy"');
  expect(rankableFormatter).toContain('delta.signal === "signal"');
  expect(rankableFormatter).toContain("unranked (${delta.signal}; raw ${delta.candidateFasterPct}%)");
  expect(consoleSummary).toContain("Rows marked underpowered, noisy, or unstable are not rankable");
  expect(consoleSummary).toContain("rankable delta");
  expect(consoleSummary).toContain("formatRankableDelta(delta)");
  expect(markdownSummary).toContain("Rows marked underpowered, noisy, or unstable are not rankable");
  expect(markdownSummary).toContain("Rankable delta");
  expect(markdownSummary).toContain("formatRankableDelta(delta)");
});

test("feature benchmark keeps binary A/B labels distinct", () => {
  const targetBuilder = functionDeclaration("buildTargets");
  const validator = functionDeclaration("validateUniqueTargetNames");

  expect(targetBuilder).toContain('"binary-ab-baseline"');
  expect(targetBuilder).toContain('"binary-ab-candidate"');
  expect(targetBuilder).not.toContain('"binary-baseline"');
  expect(targetBuilder).not.toContain('"binary-candidate"');
  expect(benchmarkSource).toContain("validateUniqueTargetNames(targets)");
  expect(validator).toContain("new Set<string>()");
  expect(validator).toContain("Duplicate benchmark target label");
});

test("feature benchmark preserves timestamped snapshots for every run", () => {
  const writer = functionDeclaration("writeBenchmarkOutputs");
  const snapshotSlug = functionDeclaration("benchmarkSnapshotSlug");
  const consoleSummary = functionDeclaration("renderConsoleSummary");

  expect(benchmarkSource).toContain('const snapshotRoot = join(repoRoot, ".tmp", "dx-bun-feature-bench-snapshots")');
  expect(benchmarkSource).toContain("writeBenchmarkOutputs(summary)");
  expect(writer).toContain('writeFileSync(join(workRoot, "results-latest.json")');
  expect(writer).toContain('writeFileSync(join(workRoot, "summary.md")');
  expect(writer).toContain('writeFileSync(join(snapshotRoot, `results-${slug}.json`)');
  expect(writer).toContain('writeFileSync(join(snapshotRoot, `summary-${slug}.md`)');
  expect(snapshotSlug).toContain("summary.generatedAtUtc");
  expect(snapshotSlug).toContain("summary.comparison.kind");
  expect(snapshotSlug).toContain("summary.targets.map");
  expect(consoleSummary).toContain("snapshot results:");
  expect(consoleSummary).toContain("snapshot summary:");
});

function parseScenarioRows(): Map<string, number[]> {
  const section = sectionBetween("const scenarios: Scenario[] = [", "];\n\nconst selectedScenarios");
  const rows = new Map<string, number[]>();
  for (const match of section.matchAll(/name: "([^"]+)",\s+rows: \[([^\]]*)\]/g)) {
    rows.set(match[1], parseRows(match[2]));
  }
  return rows;
}

function parseRowEvidence(): Map<number, string[]> {
  const section = sectionBetween(
    "const rowEvidence: Record<number, { contracts: string[]; benchmarkScenarios: string[]; note: string }> = {",
    "\n};\n\nconst scenarios",
  );
  const evidence = new Map<number, string[]>();
  for (const match of section.matchAll(/^\s+(\d+): \{[\s\S]*?benchmarkScenarios: \[([^\]]*)\]/gm)) {
    evidence.set(Number(match[1]), parseStrings(match[2]));
  }
  return evidence;
}

function parseRowEvidenceDetails(): Map<number, { scenarios: string[]; note: string }> {
  const section = sectionBetween(
    "const rowEvidence: Record<number, { contracts: string[]; benchmarkScenarios: string[]; note: string }> = {",
    "\n};\n\nconst scenarios",
  );
  const evidence = new Map<number, { scenarios: string[]; note: string }>();
  for (const match of section.matchAll(
    /^\s+(\d+): \{[\s\S]*?benchmarkScenarios: \[([^\]]*)\],[\s\S]*?note: "([^"]*)"/gm,
  )) {
    evidence.set(Number(match[1]), { scenarios: parseStrings(match[2]), note: match[3] });
  }
  expect(evidence.size).toBe(30);
  return evidence;
}

function sectionBetween(startMarker: string, endMarker: string): string {
  const start = benchmarkSource.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = benchmarkSource.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return benchmarkSource.slice(start, end);
}

function parseRows(value: string): number[] {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item));
}

function parseStrings(value: string): string[] {
  return [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function functionBody(name: string): string {
  const marker = `function ${name}()`;
  const start = benchmarkSource.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextFunction = benchmarkSource.indexOf("\nfunction ", start + marker.length);
  expect(nextFunction).toBeGreaterThan(start);
  return benchmarkSource.slice(start, nextFunction);
}

function functionDeclaration(name: string): string {
  const marker = `function ${name}`;
  const start = benchmarkSource.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextFunction = benchmarkSource.indexOf("\nfunction ", start + marker.length);
  expect(nextFunction).toBeGreaterThan(start);
  return benchmarkSource.slice(start, nextFunction);
}

function parseNumberConst(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name} = (\\d+);`));
  expect(match).not.toBeNull();
  return Number(match![1]);
}
