import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

type BunTarget = {
  name: string;
  path: string;
  revision: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  envOverrides?: NodeJS.ProcessEnv;
};

type ParentRunner = {
  execPath: string;
  revision: string;
  version: string;
  matchesOfficialPath: boolean;
};

type Sample = {
  ms: number;
  output: string;
};

type BenchmarkSignal = "signal" | "noisy" | "unstable" | "underpowered";

type ScenarioResult = {
  scenario: string;
  rows: number[];
  target: string;
  revision: string;
  version: string;
  meanMs: number;
  trimmedMeanMs: number;
  medianMs: number;
  iqrMs: number;
  cvPct: number;
  minMs: number;
  maxMs: number;
  samplesMs: number[];
  runs: number;
  warmups: number;
  output: string;
};

type PreparedScenario = {
  name: string;
  rows: number[];
  description: string;
  expectedOutput?: string;
  run(target: BunTarget, sampleIndex: number): Sample;
  compareOutput?: boolean;
};

type Scenario = {
  name: string;
  rows: number[];
  description: string;
  prepare(): PreparedScenario;
};

type BenchmarkSummary = {
  generatedAtUtc: string;
  method: string;
  comparison: ReturnType<typeof buildComparisonSummary>;
  parentRunner: ParentRunner;
  targets: BunTarget[];
  coverage: ReturnType<typeof buildCoverageSummary>;
  results: ScenarioResult[];
  deltas: ReturnType<typeof buildDeltas>;
};

type BenchmarkOutputPaths = {
  latestResults: string;
  latestSummary: string;
  snapshotResults: string;
  snapshotSummary: string;
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = join(repoRoot, ".tmp", "dx-bun-feature-bench");
const snapshotRoot = join(repoRoot, ".tmp", "dx-bun-feature-bench-snapshots");
const officialBun = process.env.DX_OFFICIAL_BUN || "G:\\Dev\\Tools\\Bun\\bin\\bun.exe";
const localBun = process.env.DX_LOCAL_BUN || join(repoRoot, "build", "release", "bun.exe");
const runs = positiveIntegerEnv("DX_FEATURE_BENCH_RUNS", 20);
const warmups = positiveIntegerEnv("DX_FEATURE_BENCH_WARMUPS", 3);
const whichPathIterations = positiveIntegerEnv("DX_FEATURE_BENCH_WHICH_ITERATIONS", 2000);
const spawnTimeoutMs = positiveIntegerEnv("DX_FEATURE_BENCH_SPAWN_TIMEOUT_MS", 120000);
const benchmarkMode = process.env.DX_FEATURE_BENCH_MODE || "official-vs-local";
const scenarioNameFilter = parseNameFilterEnv("DX_FEATURE_BENCH_SCENARIOS");
const baselineEnvOverrides = parseEnvJson("DX_FEATURE_BENCH_BASELINE_ENV_JSON");
const candidateEnvOverrides = parseEnvJson("DX_FEATURE_BENCH_CANDIDATE_ENV_JSON");
const trimRatio = 0.1;
const minRankableRuns = 20;
const benchmarkBaseEnv = sanitizedBenchmarkEnv();

const rowEvidence: Record<number, { contracts: string[]; benchmarkScenarios: string[]; note: string }> = {
  1: {
    contracts: ["scripts/dx-js-machine-cache-script.test.ts", "G:/dx/serializer/src/bin/serialize.rs"],
    benchmarkScenarios: [],
    note: "Serializer batch generator is outside Bun runtime; compare with serializer cargo/build smokes, not official Bun runtime.",
  },
  2: {
    contracts: ["scripts/dx-machine-cache-shadow-contract.test.ts", "src/resolver/dx_machine_cache.rs"],
    benchmarkScenarios: [],
    note: "Opt-in shadow reader remains parser-adjacent validation, not parser replacement.",
  },
  3: {
    contracts: ["scripts/dx-js-machine-cache-script.test.ts", "scripts/dx-js-machine-cache-index-contract.test.ts"],
    benchmarkScenarios: [],
    note: "Artifact emission belongs to the external dx-serialize tree plus the PowerShell generator.",
  },
  4: {
    contracts: ["scripts/dx-machine-cache-shadow-contract.test.ts", "src/resolver/dx_machine_cache.rs"],
    benchmarkScenarios: [],
    note: "Mmap reader is shadow validation only today.",
  },
  5: {
    contracts: ["scripts/dx-machine-cache-shadow-contract.test.ts", "scripts/dx-js-machine-cache-index-contract.test.ts"],
    benchmarkScenarios: [],
    note: "Trust-boundary correctness is covered by contracts and cargo checks.",
  },
  6: {
    contracts: ["scripts/dx-path-source-index-map-contract.test.ts"],
    benchmarkScenarios: ["bundler-minify-sourcemap"],
    note: "Safe owning path map is source-proven; bundler benchmark gives indirect runtime pressure.",
  },
  7: {
    contracts: ["scripts/dx-js-workspace-cache-contract.test.ts"],
    benchmarkScenarios: ["workspace-install-lockfile"],
    note: "Workspace install fixture exercises package JSON workspace cache behavior.",
  },
  8: {
    contracts: ["scripts/dx-tsconfig-path-matcher-contract.test.ts"],
    benchmarkScenarios: [
      "tsconfig-paths-runtime",
      "tsconfig-paths-exact-runtime",
      "tsconfig-paths-wildcard-runtime",
      "tsconfig-paths-fallback-runtime",
    ],
    note: "Runtime fixtures import mixed, exact-only, wildcard-only, and fallback-heavy tsconfig aliases.",
  },
  9: {
    contracts: ["scripts/dx-generated-alias-runtime-contract.test.ts", "scripts/dx-phf-generated-table-contract.test.ts"],
    benchmarkScenarios: ["generated-alias-test-runner"],
    note: "Alias runtime benchmark uses bun:test aliases and builtin aliases.",
  },
  10: {
    contracts: ["scripts/dx-sourcemap-internal-cache-contract.test.ts"],
    benchmarkScenarios: ["bundler-minify-sourcemap"],
    note: "Identity-context maps are compile/source-proven; sourcemap build path applies pressure.",
  },
  11: {
    contracts: ["scripts/dx-resolver-literal-probes-contract.test.ts", "src/resolver/fs.rs"],
    benchmarkScenarios: [],
    note: "Resolver literal probes are source-proven for package.json, node_modules, and .bin; exports/imports runtime pressure belongs to rows 19-21.",
  },
  12: {
    contracts: ["scripts/dx-path-byte-scan-contract.test.ts"],
    benchmarkScenarios: ["resolver-exports-imports-heavy"],
    note: "Path scan is source-proven; resolver fixture hits node_modules paths.",
  },
  13: {
    contracts: ["scripts/dx-simd-char-frequency-contract.test.ts", "src/ast/char_freq.rs"],
    benchmarkScenarios: ["bundler-minify-sourcemap"],
    note: "same-local-char-frequency-simd isolates the SIMD scan through bundler/minify pressure.",
  },
  14: {
    contracts: ["scripts/dx-tsconfig-path-matcher-contract.test.ts", "scripts/dx-package-exports-runtime-contract.test.ts"],
    benchmarkScenarios: [
      "tsconfig-paths-runtime",
      "tsconfig-paths-exact-runtime",
      "tsconfig-paths-wildcard-runtime",
      "tsconfig-paths-fallback-runtime",
      "resolver-exports-imports-heavy",
      "resolver-wildcard-conditions-heavy",
    ],
    note: "SmallVec resolver storage is covered by source contracts plus split tsconfig and resolver wildcard/condition fixtures.",
  },
  15: {
    contracts: ["scripts/dx-smallvec-scratch-contract.test.ts"],
    benchmarkScenarios: ["workspace-install-lockfile"],
    note: "Install scratch lists are indirectly exercised by workspace install.",
  },
  16: {
    contracts: ["scripts/dx-js-machine-cache-index-contract.test.ts", "scripts/dx-machine-cache-shadow-contract.test.ts"],
    benchmarkScenarios: [],
    note: "Packed shard correctness is serializer/Bun shadow-reader evidence, not official runtime comparison.",
  },
  17: {
    contracts: ["scripts/dx-serializer-payload-contract.test.ts"],
    benchmarkScenarios: [],
    note: "Serializer envelope allocation behavior is outside official Bun runtime.",
  },
  18: {
    contracts: ["scripts/dx-js-package-json-cache.test.ts", "scripts/dx-js-machine-cache-script.test.ts"],
    benchmarkScenarios: [],
    note: "Active key interning is package-json machine-cache metadata today; generic serializer intern.rs is dormant, not parser replacement.",
  },
  19: {
    contracts: ["scripts/dx-package-exports-runtime-contract.test.ts"],
    benchmarkScenarios: ["resolver-exports-imports-heavy", "resolver-exact-index-heavy", "resolver-wildcard-conditions-heavy"],
    note: "Exports/imports storage is exercised by package resolution fixture.",
  },
  20: {
    contracts: ["scripts/dx-package-exports-runtime-contract.test.ts"],
    benchmarkScenarios: ["resolver-exports-imports-heavy", "resolver-exact-index-heavy", "resolver-wildcard-conditions-heavy"],
    note: "MultiArrayList layout is source-proven and runtime-resolved.",
  },
  21: {
    contracts: ["scripts/dx-package-exports-runtime-contract.test.ts"],
    benchmarkScenarios: ["resolver-exports-imports-heavy", "resolver-exact-index-heavy"],
    note: "Exact-key index is directly exercised by mixed and exact-heavy exports/imports fixtures.",
  },
  22: {
    contracts: ["scripts/dx-runtime-transpiler-cache-contract.test.ts"],
    benchmarkScenarios: ["runtime-transpiler-cache-hit"],
    note: "Second-run cache-hit benchmark uses per-target cache dirs.",
  },
  23: {
    contracts: ["scripts/dx-sourcemap-internal-cache-contract.test.ts"],
    benchmarkScenarios: ["bundler-minify-sourcemap"],
    note: "Sourcemap cache behavior is source-proven and build path applies pressure.",
  },
  24: {
    contracts: ["scripts/dx-printer-number-format-contract.test.ts"],
    benchmarkScenarios: ["bundler-minify-sourcemap"],
    note: "Printer number formatting is indirectly exercised by minified numeric bundle output.",
  },
  25: {
    contracts: ["scripts/dx-path-buffer-pool-contract.test.ts", "src/paths/path_buffer_pool.rs"],
    benchmarkScenarios: ["bundler-minify-sourcemap", "resolver-exports-imports-heavy"],
    note: "Path pool is path-heavy runtime pressure plus source evidence.",
  },
  26: {
    contracts: ["scripts/dx-which-path-reuse-contract.test.ts", "src/which/lib.rs"],
    benchmarkScenarios: ["which-path-resolution"],
    note: "Windows which UTF-16 bin-name reuse is exercised through repeated Bun.which PATH lookups; PATH segment conversion is still per probe.",
  },
  27: {
    contracts: ["scripts/dx-phf-generated-table-contract.test.ts"],
    benchmarkScenarios: ["workspace-install-lockfile", "trusted-deps-default-table"],
    note: "Trusted dependency table is source/runtime-smoke proven; default-table command directly exercises generated output and install path applies pressure.",
  },
  28: {
    contracts: ["scripts/dx-libdeflate-extract-pool-contract.test.ts"],
    benchmarkScenarios: ["local-tarball-install"],
    note: "Local file: tgz install exercises gzip tarball extraction without network.",
  },
  29: {
    contracts: ["scripts/dx-threadpool-stack-bounds-contract.test.ts"],
    benchmarkScenarios: [],
    note: "Stack-bounds policy is a source invariant, not a meaningful official/local microbenchmark.",
  },
  30: {
    contracts: ["scripts/dx-js-machine-cache-script.test.ts", "scripts/dx-js-machine-cache-index-contract.test.ts"],
    benchmarkScenarios: [],
    note: "Compression policy is serializer/cache-artifact correctness, not official runtime comparison.",
  },
};

const scenarios: Scenario[] = [
  {
    name: "resolver-exports-imports-heavy",
    rows: [12, 14, 19, 20, 21, 25],
    description: "Package exports/imports with exact keys, wildcard keys, root imports, and node_modules path resolution.",
    prepare: prepareResolverExportsImports,
  },
  {
    name: "resolver-exact-index-heavy",
    rows: [19, 20, 21],
    description: "Package exports/imports dominated by exact keys above the exact-index threshold.",
    prepare: prepareResolverExactIndex,
  },
  {
    name: "resolver-wildcard-conditions-heavy",
    rows: [12, 14, 19, 20, 25],
    description: "Package exports/imports dominated by wildcard expansion and condition-map selection.",
    prepare: prepareResolverWildcardConditions,
  },
  {
    name: "tsconfig-paths-runtime",
    rows: [8, 14],
    description: "Runtime TypeScript imports through exact and wildcard tsconfig paths.",
    prepare: prepareTsconfigPaths,
  },
  {
    name: "tsconfig-paths-exact-runtime",
    rows: [8, 14],
    description: "Runtime TypeScript imports through exact-only tsconfig paths.",
    prepare: prepareTsconfigExactPaths,
  },
  {
    name: "tsconfig-paths-wildcard-runtime",
    rows: [8, 14],
    description: "Runtime TypeScript imports through wildcard-only tsconfig paths.",
    prepare: prepareTsconfigWildcardPaths,
  },
  {
    name: "tsconfig-paths-fallback-runtime",
    rows: [8, 14],
    description: "Runtime TypeScript imports that miss first tsconfig targets and resolve through fallback targets.",
    prepare: prepareTsconfigFallbackPaths,
  },
  {
    name: "generated-alias-test-runner",
    rows: [9],
    description: "bun:test aliases plus Node builtin alias resolution.",
    prepare: prepareGeneratedAliases,
  },
  {
    name: "runtime-transpiler-cache-hit",
    rows: [22],
    description: "Second-run TypeScript runtime transpiler cache hit with per-binary cache directories.",
    prepare: prepareRuntimeTranspilerCache,
  },
  {
    name: "bundler-minify-sourcemap",
    rows: [6, 10, 13, 23, 24, 25],
    description: "Bundle/minify/sourcemap workload over many TS modules and numeric literals.",
    prepare: prepareBundlerMinifySourcemap,
  },
  {
    name: "workspace-install-lockfile",
    rows: [7, 15, 27],
    description: "Offline workspace install lockfile generation across many local packages.",
    prepare: prepareWorkspaceInstall,
  },
  {
    name: "trusted-deps-default-table",
    rows: [27],
    description: "Generated default trusted dependency table command.",
    prepare: prepareDefaultTrustedDeps,
  },
  {
    name: "which-path-resolution",
    rows: [26],
    description: "Repeated Bun.which lookups across a long Windows PATH with the hit near the end.",
    prepare: prepareWhichPathResolution,
  },
  {
    name: "local-tarball-install",
    rows: [28],
    description: "Offline file: tgz dependency install to exercise gzip tarball extraction.",
    prepare: prepareLocalTarballInstall,
  },
];

const selectedScenarios = selectScenarios(scenarios, scenarioNameFilter);
rmSync(workRoot, { recursive: true, force: true });
mkdirSync(workRoot, { recursive: true });

const targets = buildTargets();
validateUniqueTargetNames(targets);
const parentRunner = readParentRunner(targets[0]);
const coverage = buildCoverageSummary();
validateCoverageMapping(coverage);
const prepared = selectedScenarios.map((scenario) => scenario.prepare());
const results: ScenarioResult[] = [];

for (const scenario of prepared) {
  console.log(`[dx-bench] starting ${scenario.name}`);

  try {
  for (let i = 0; i < warmups; i += 1) {
    for (const target of alternatingTargets(i, targets)) {
      scenario.run(target, -1 - i);
    }
  }

  const samplesByTarget = new Map<string, Sample[]>();
  for (const target of targets) {
    samplesByTarget.set(target.name, []);
  }

  for (let i = 0; i < runs; i += 1) {
    for (const target of alternatingTargets(i, targets)) {
      samplesByTarget.get(target.name)!.push(scenario.run(target, i));
    }
  }

  const baselineOutput = samplesByTarget.get(targets[0].name)![0]?.output ?? "";
  if (scenario.compareOutput !== false) {
    if (scenario.expectedOutput !== undefined && baselineOutput !== scenario.expectedOutput) {
      throw new Error(`${scenario.name} expected output mismatch\nexpected: ${scenario.expectedOutput}\nactual: ${baselineOutput}`);
    }
    for (const target of targets) {
      for (const sample of samplesByTarget.get(target.name)!) {
        if (sample.output !== baselineOutput) {
          throw new Error(`${scenario.name} output mismatch for ${target.name}\n${targets[0].name}: ${baselineOutput}\n${target.name}: ${sample.output}`);
        }
      }
    }
  }

  for (const target of targets) {
    const samples = samplesByTarget.get(target.name)!;
    const metrics = sampleMetrics(samples.map((sample) => sample.ms));
    results.push({
      scenario: scenario.name,
      rows: scenario.rows,
      target: target.name,
      revision: target.revision,
      version: target.version,
      meanMs: round3(metrics.mean),
      trimmedMeanMs: round3(metrics.trimmedMean),
      medianMs: round3(metrics.median),
      iqrMs: round3(metrics.iqr),
      cvPct: round3(metrics.cvPct),
      minMs: round3(metrics.min),
      maxMs: round3(metrics.max),
      samplesMs: samples.map((sample) => round3(sample.ms)),
      runs,
      warmups,
      output: samples[0]?.output ?? "",
    });
  }

  writeBenchmarkOutputs(buildBenchmarkSummary(results));
  console.log(`[dx-bench] completed ${scenario.name}`);
  } catch (error) {
    writeBenchmarkFailureOutputs(scenario, error, buildBenchmarkSummary(results));
    throw error;
  }
}

const summary = buildBenchmarkSummary(results);

const outputPaths = writeBenchmarkOutputs(summary);
console.log(renderConsoleSummary(summary, outputPaths));

function buildBenchmarkSummary(results: ScenarioResult[]): BenchmarkSummary {
  const comparison = buildComparisonSummary(targets);
  return {
    generatedAtUtc: new Date().toISOString(),
    method: `mode=${benchmarkMode}; scenarios=${selectedScenarios.map((scenario) => scenario.name).join(",")}; ${warmups} warmups, ${runs} alternating measured runs, output/integrity equality checks for every scenario, runtime transpiler cache env disabled except the dedicated cache-hit scenario, ${trimmedMeanDescription(runs)}`,
    comparison,
    parentRunner,
    targets,
    coverage,
    results,
    deltas: buildDeltas(results, targets, comparison),
  };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNameFilterEnv(name: string): Set<string> {
  const raw = process.env[name]?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(/[,\s]+/).filter(Boolean));
}

function writeBenchmarkOutputs(summary: BenchmarkSummary): BenchmarkOutputPaths {
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(snapshotRoot, { recursive: true });

  const latestResults = join(workRoot, "results-latest.json");
  const latestSummary = join(workRoot, "summary.md");
  const slug = benchmarkSnapshotSlug(summary);
  const snapshotResults = join(snapshotRoot, `results-${slug}.json`);
  const snapshotSummary = join(snapshotRoot, `summary-${slug}.md`);
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  const markdown = renderMarkdownSummary(summary);

  writeFileSync(join(workRoot, "results-latest.json"), json);
  writeFileSync(join(workRoot, "summary.md"), markdown);
  writeFileSync(join(snapshotRoot, `results-${slug}.json`), json);
  writeFileSync(join(snapshotRoot, `summary-${slug}.md`), markdown);

  return { latestResults, latestSummary, snapshotResults, snapshotSummary };
}

function writeBenchmarkFailureOutputs(scenario: PreparedScenario, error: unknown, summary: BenchmarkSummary): void {
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(snapshotRoot, { recursive: true });

  const failure = {
    generatedAtUtc: new Date().toISOString(),
    scenario: scenario.name,
    completedScenarios: [...new Set(summary.results.map((item) => item.scenario))],
    error: serializeError(error),
    summary,
  };
  const slug = `${benchmarkSnapshotSlug(summary)}-${safeSnapshotPart(scenario.name)}-failure`.slice(0, 240);
  const json = `${JSON.stringify(failure, null, 2)}\n`;
  const markdown = [
    "# DX Bun Feature Benchmark Failure",
    "",
    `Generated: ${failure.generatedAtUtc}`,
    `Scenario: ${failure.scenario}`,
    `Completed scenarios: ${failure.completedScenarios.join(", ") || "none"}`,
    "",
    "```text",
    failure.error.stack || failure.error.message,
    "```",
    "",
  ].join("\n");

  writeFileSync(join(workRoot, "failure-latest.json"), json);
  writeFileSync(join(workRoot, "failure.md"), markdown);
  writeFileSync(join(snapshotRoot, `failure-${slug}.json`), json);
  writeFileSync(join(snapshotRoot, `failure-${slug}.md`), markdown);
}

function serializeError(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? error.message,
    };
  }

  const message = String(error);
  return {
    name: "Error",
    message,
    stack: message,
  };
}

function benchmarkSnapshotSlug(summary: BenchmarkSummary): string {
  const timestamp = summary.generatedAtUtc.replace(/\D/g, "").slice(0, 17);
  const parts = [
    timestamp,
    summary.comparison.kind,
    benchmarkMode,
    ...summary.targets.map((target) => `${target.name}-${target.revision}`),
  ];
  return parts.map(safeSnapshotPart).filter(Boolean).join("-").slice(0, 220);
}

function safeSnapshotPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function selectScenarios(allScenarios: readonly Scenario[], selectedNames: ReadonlySet<string>): Scenario[] {
  if (selectedNames.size === 0) return [...allScenarios];
  const knownNames = new Set(allScenarios.map((scenario) => scenario.name));
  const unknown = [...selectedNames].filter((name) => !knownNames.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown DX_FEATURE_BENCH_SCENARIOS value(s): ${unknown.join(", ")}`);
  }
  return allScenarios.filter((scenario) => selectedNames.has(scenario.name));
}

function buildTargets(): BunTarget[] {
  switch (benchmarkMode) {
    case "official-vs-local":
      return [readTarget("official", officialBun, baselineEnvOverrides), readTarget("local", localBun, candidateEnvOverrides)];
    case "binary-ab":
      return [
        readTarget(process.env.DX_FEATURE_BENCH_BASELINE_LABEL || "binary-ab-baseline", requiredEnv("DX_FEATURE_BENCH_BASELINE_BUN"), baselineEnvOverrides),
        readTarget(process.env.DX_FEATURE_BENCH_CANDIDATE_LABEL || "binary-ab-candidate", requiredEnv("DX_FEATURE_BENCH_CANDIDATE_BUN"), candidateEnvOverrides),
      ];
    case "same-local-ab":
      if (Object.keys(candidateEnvOverrides).length === 0 && process.env.DX_FEATURE_BENCH_ALLOW_AA !== "1") {
        throw new Error("same-local-ab requires DX_FEATURE_BENCH_CANDIDATE_ENV_JSON unless DX_FEATURE_BENCH_ALLOW_AA=1");
      }
      return [
        readTarget("local-control", localBun, baselineEnvOverrides),
        readTarget("local-candidate", localBun, candidateEnvOverrides),
      ];
    case "same-local-aa":
      return [
        readTarget("local-aa-a", localBun, baselineEnvOverrides),
        readTarget("local-aa-b", localBun, baselineEnvOverrides),
      ];
    case "same-local-libdeflate":
      return [
        readTarget("local-libdeflate-on", localBun, baselineEnvOverrides),
        readTarget("local-libdeflate-off", localBun, { ...candidateEnvOverrides, BUN_FEATURE_FLAG_NO_LIBDEFLATE: "1" }),
      ];
    case "same-local-libdeflate-pool":
      return [
        readTarget("local-libdeflate-pool-on", localBun, baselineEnvOverrides),
        readTarget("local-libdeflate-pool-off", localBun, {
          ...candidateEnvOverrides,
          BUN_DX_DISABLE_LIBDEFLATE_EXTRACT_POOL: "1",
        }),
      ];
    case "same-local-tsconfig-precomputed":
      return [
        readTarget("local-tsconfig-precomputed-on", localBun, baselineEnvOverrides),
        readTarget("local-tsconfig-precomputed-off", localBun, {
          ...candidateEnvOverrides,
          BUN_DX_DISABLE_TSCONFIG_PRECOMPUTED_PATH_MATCHER: "1",
        }),
      ];
    case "same-local-char-frequency-simd":
      return [
        readTarget("local-char-frequency-simd-on", localBun, baselineEnvOverrides),
        readTarget("local-char-frequency-simd-off", localBun, {
          ...candidateEnvOverrides,
          BUN_DX_DISABLE_SIMD_CHAR_FREQUENCY: "1",
        }),
      ];
    case "same-local-resolver-conditions-inline":
      return [
        readTarget("local-resolver-conditions-inline-on", localBun, baselineEnvOverrides),
        readTarget("local-resolver-conditions-inline-off", localBun, {
          ...candidateEnvOverrides,
          BUN_DX_DISABLE_RESOLVER_INLINE_CONDITIONS_MAP: "1",
        }),
      ];
    case "same-local-which":
      return [
        readTarget("local-which-reuse-on", localBun, baselineEnvOverrides),
        readTarget("local-which-reuse-off", localBun, { ...candidateEnvOverrides, BUN_DX_DISABLE_WHICH_BIN_UTF16_REUSE: "1" }),
      ];
    case "same-local-exports-index":
      return [
        readTarget("local-exports-index-on", localBun, baselineEnvOverrides),
        readTarget("local-exports-index-off", localBun, { ...candidateEnvOverrides, BUN_DX_DISABLE_EXPORTS_EXACT_KEY_INDEX: "1" }),
      ];
    default:
      throw new Error(`Unsupported DX_FEATURE_BENCH_MODE: ${benchmarkMode}`);
  }
}

function validateUniqueTargetNames(targets: readonly BunTarget[]): void {
  const names = new Set<string>();
  for (const target of targets) {
    const name = target.name.trim();
    if (!name) {
      throw new Error("Benchmark target label must not be empty");
    }
    if (names.has(name)) {
      throw new Error(`Duplicate benchmark target label: ${target.name}`);
    }
    names.add(name);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when DX_FEATURE_BENCH_MODE=binary-ab`);
  }
  return value;
}

function parseEnvJson(name: string): NodeJS.ProcessEnv {
  const raw = process.env[name]?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of string key/value pairs`);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`${name}.${key} must be a string`);
    }
    env[key] = value;
  }
  return env;
}

function readTarget(name: string, path: string, envOverrides: NodeJS.ProcessEnv = {}): BunTarget {
  if (!existsSync(path)) {
    throw new Error(`Missing ${name} Bun executable: ${path}`);
  }
  const env = sanitizedBenchmarkEnv(envOverrides);
  const stats = statSync(path);
  return {
    name,
    path,
    revision: runAndRead(path, ["--revision"], repoRoot, env),
    version: runAndRead(path, ["--version"], repoRoot, env),
    sha256: sha256(readFileSync(path)),
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    envOverrides,
  };
}

function readParentRunner(official: BunTarget): ParentRunner {
  return {
    execPath: process.execPath,
    revision: runAndRead(process.execPath, ["--revision"], repoRoot),
    version: runAndRead(process.execPath, ["--version"], repoRoot),
    matchesOfficialPath: normalizedPath(process.execPath) === normalizedPath(official.path),
  };
}

function normalizedPath(path: string): string {
  return path.replaceAll("/", "\\").toLowerCase();
}

function runAndRead(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = benchmarkBaseEnv): string {
  const result = spawnSync(binary, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: spawnTimeoutMs,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(formatSpawnFailure(`${binary} ${args.join(" ")}`, result));
  }
  return `${result.stdout}${result.stderr}`.trim();
}

function alternatingTargets(index: number, targetList: readonly BunTarget[]): BunTarget[] {
  return index % 2 === 0 ? [...targetList] : [...targetList].reverse();
}

function sanitizedBenchmarkEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("BUN_")) {
      delete env[key];
    }
  }
  Object.assign(env, overrides);
  return env;
}

function envForTarget(target: BunTarget, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return sanitizedBenchmarkEnv({ ...target.envOverrides, ...overrides });
}

function timedSpawn(
  target: BunTarget,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  normalize: (result: SpawnSyncReturns<string>) => string = defaultNormalize,
): Sample {
  const started = performance.now();
  const result = spawnSync(target.path, args, {
    cwd,
    env: envForTarget(target, env),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 16,
    timeout: spawnTimeoutMs,
  });
  const ms = performance.now() - started;
  if (result.status !== 0 || result.error) {
    throw new Error(formatSpawnFailure(`${target.name} failed ${args.join(" ")} in ${cwd}`, result));
  }
  return {
    ms,
    output: normalize(result),
  };
}

function formatSpawnFailure(label: string, result: SpawnSyncReturns<string>): string {
  const stdout = result.stdout ? `\nstdout:\n${result.stdout}` : "";
  const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : "";
  const error = result.error ? `\nerror: ${result.error.message}` : "";
  return `${label}\nstatus=${result.status ?? "null"} signal=${result.signal ?? "null"} timeoutMs=${spawnTimeoutMs}${error}${stderr}${stdout}`;
}

function defaultNormalize(result: SpawnSyncReturns<string>): string {
  return `${result.stdout}${result.stderr}`
    .replaceAll(repoRoot.replaceAll("\\", "/"), "<repo>")
    .replaceAll(repoRoot, "<repo>")
    .replace(/bun (?:test |install )?v[^\r\n]+/g, "bun <version>")
    .replace(/\[[0-9.]+m?s\]/g, "[time]")
    .replace(/[0-9]+(?:\.[0-9]+)?m?s/g, "<time>")
    .replace(/\r\n/g, "\n")
    .trim();
}

function sampleMetrics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const trim = effectiveTrimCount(sorted.length);
  const trimmed = trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
  const meanValue = average(values);
  return {
    mean: meanValue,
    trimmedMean: average(trimmed),
    median: median(sorted),
    iqr: percentile(sorted, 0.75) - percentile(sorted, 0.25),
    cvPct: meanValue > 0 ? (standardDeviation(values, meanValue) / meanValue) * 100 : 0,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(sortedValues: number[]): number {
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) {
    return sortedValues[middle];
  }
  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function standardDeviation(values: number[], meanValue: number): number {
  const variance = average(values.map((value) => (value - meanValue) ** 2));
  return Math.sqrt(variance);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function effectiveTrimCount(sampleCount: number): number {
  const trim = Math.floor(sampleCount * trimRatio);
  return trim > 0 && trim * 2 < sampleCount ? trim : 0;
}

function trimmedMeanDescription(sampleCount: number): string {
  const trim = effectiveTrimCount(sampleCount);
  if (trim === 0) {
    return `untrimmed means (run count too low for ${Math.round(trimRatio * 100)}% trimming)`;
  }

  return `${Math.round(trimRatio * 100)}% trimmed means, dropping ${trim} fastest and ${trim} slowest sample per target`;
}

function prepareResolverExportsImports(): PreparedScenario {
  const cwd = join(workRoot, "resolver-exports-imports-heavy");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(join(cwd, "node_modules", "@dx", "heavy", "features"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "@dx", "heavy", "bad"), { recursive: true });
  mkdirSync(join(cwd, "local"), { recursive: true });
  mkdirSync(join(cwd, "bad"), { recursive: true });

  const imports: Record<string, unknown> = {
    "#internal": { bun: "./local/internal.ts", default: "./bad/internal.ts" },
  };
  const exactImportCount = 160;
  const exactExportCount = 160;
  const wildcardFeatureCount = 48;

  for (let i = 0; i < exactImportCount; i += 1) {
    imports[`#tool/${i}`] = { bun: `./local/tool-${i}.ts`, default: `./bad/tool-${i}.ts` };
    writeFileSync(join(cwd, "local", `tool-${i}.ts`), `export default ${i + 10};\n`);
    writeFileSync(join(cwd, "bad", `tool-${i}.ts`), `export default -${i + 10};\n`);
  }
  writeFileSync(join(cwd, "local", "internal.ts"), "export default 7;\n");
  writeFileSync(join(cwd, "bad", "internal.ts"), "export default -7;\n");
  writeJson(join(cwd, "package.json"), { type: "module", imports });

  const packageRoot = join(cwd, "node_modules", "@dx", "heavy");
  const exportsMap: Record<string, unknown> = {
    ".": { bun: "./root.ts", default: "./bad-root.ts" },
  };
  for (let i = 0; i < exactExportCount; i += 1) {
    exportsMap[`./exact/${i}`] = { bun: `./exact-${i}.ts`, default: `./bad-${i}.ts` };
    writeFileSync(join(packageRoot, `exact-${i}.ts`), `export default ${i + 100};\n`);
    writeFileSync(join(packageRoot, `bad-${i}.ts`), `export default -${i + 100};\n`);
  }
  exportsMap["./feature/*"] = { bun: "./features/*.ts", default: "./bad/*.ts" };
  for (let i = 0; i < wildcardFeatureCount; i += 1) {
    writeFileSync(join(packageRoot, "features", `${i}.ts`), `export default ${i + 1000};\n`);
    writeFileSync(join(packageRoot, "bad", `${i}.ts`), `export default -${i + 1000};\n`);
  }
  writeFileSync(join(packageRoot, "root.ts"), "export default 5;\n");
  writeFileSync(join(packageRoot, "bad-root.ts"), "export default -5;\n");
  writeJson(join(packageRoot, "package.json"), {
    name: "@dx/heavy",
    version: "1.0.0",
    type: "module",
    exports: exportsMap,
  });

  let expectedTotal = 5 + 7;
  for (let i = 0; i < Math.min(exactExportCount, exactImportCount); i += 1) {
    expectedTotal += i + 100 + i + 10;
  }
  for (let i = 0; i < wildcardFeatureCount; i += 1) {
    expectedTotal += i + 1000;
  }
  for (let i = 0; i < 120000; i += 1) {
    expectedTotal = (expectedTotal + ((i * 33) ^ 5)) | 0;
  }

  const importsSource = [
    'import root from "@dx/heavy";',
    'import internal from "#internal";',
    ...Array.from({ length: exactExportCount }, (_, i) => `import exact${i} from "@dx/heavy/exact/${i}";`),
    ...Array.from({ length: wildcardFeatureCount }, (_, i) => `import feature${i} from "@dx/heavy/feature/${i}";`),
    ...Array.from({ length: exactImportCount }, (_, i) => `import tool${i} from "#tool/${i}";`),
    "let total = root + internal;",
    ...Array.from({ length: Math.min(exactExportCount, exactImportCount) }, (_, i) => `total += exact${i} + tool${i};`),
    ...Array.from({ length: wildcardFeatureCount }, (_, i) => `total += feature${i};`),
    "for (let i = 0; i < 120000; i += 1) total = (total + ((i * 33) ^ root)) | 0;",
    'console.log("resolver:" + total);',
    "",
  ].join("\n");
  writeFileSync(join(cwd, "entry.ts"), importsSource);

  return {
    name: "resolver-exports-imports-heavy",
    rows: [12, 14, 19, 20, 21, 25],
    description: "Package exports/imports with exact keys, wildcard keys, root imports, and node_modules path resolution.",
    expectedOutput: `resolver:${expectedTotal}`,
    run: (target) => timedSpawn(target, ["entry.ts"], cwd),
  };
}

function prepareResolverExactIndex(): PreparedScenario {
  const cwd = join(workRoot, "resolver-exact-index-heavy");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(join(cwd, "node_modules", "@dx", "exact"), { recursive: true });
  mkdirSync(join(cwd, "local"), { recursive: true });
  mkdirSync(join(cwd, "bad"), { recursive: true });

  const exactImportCount = 192;
  const exactExportCount = 192;
  const imports: Record<string, unknown> = {};
  for (let i = 0; i < exactImportCount; i += 1) {
    imports[`#exact/${i}`] = { bun: `./local/import-${i}.ts`, default: `./bad/import-${i}.ts` };
    writeFileSync(join(cwd, "local", `import-${i}.ts`), `export default ${i + 1};\n`);
    writeFileSync(join(cwd, "bad", `import-${i}.ts`), `export default -${i + 1};\n`);
  }
  writeJson(join(cwd, "package.json"), { type: "module", imports });

  const packageRoot = join(cwd, "node_modules", "@dx", "exact");
  const exportsMap: Record<string, unknown> = {};
  for (let i = 0; i < exactExportCount; i += 1) {
    exportsMap[`./exact/${i}`] = { bun: `./export-${i}.ts`, default: `./bad-${i}.ts` };
    writeFileSync(join(packageRoot, `export-${i}.ts`), `export default ${i + 1000};\n`);
    writeFileSync(join(packageRoot, `bad-${i}.ts`), `export default -${i + 1000};\n`);
  }
  writeJson(join(packageRoot, "package.json"), {
    name: "@dx/exact",
    version: "1.0.0",
    type: "module",
    exports: exportsMap,
  });

  let expectedTotal = 0;
  const pairCount = Math.min(exactImportCount, exactExportCount);
  for (let i = 0; i < pairCount; i += 1) {
    expectedTotal += i + 1 + i + 1000;
  }
  for (let i = 0; i < 90000; i += 1) {
    expectedTotal = (expectedTotal + ((i * 17) ^ 11)) | 0;
  }

  writeFileSync(
    join(cwd, "entry.ts"),
    [
      ...Array.from({ length: exactExportCount }, (_, i) => `import export${i} from "@dx/exact/exact/${i}";`),
      ...Array.from({ length: exactImportCount }, (_, i) => `import import${i} from "#exact/${i}";`),
      "let total = 0;",
      ...Array.from({ length: pairCount }, (_, i) => `total += export${i} + import${i};`),
      "for (let i = 0; i < 90000; i += 1) total = (total + ((i * 17) ^ 11)) | 0;",
      'console.log("resolver-exact:" + total);',
      "",
    ].join("\n"),
  );

  return {
    name: "resolver-exact-index-heavy",
    rows: [19, 20, 21],
    description: "Package exports/imports dominated by exact keys above the exact-index threshold.",
    expectedOutput: `resolver-exact:${expectedTotal}`,
    run: (target) => timedSpawn(target, ["entry.ts"], cwd),
  };
}

function prepareResolverWildcardConditions(): PreparedScenario {
  const cwd = join(workRoot, "resolver-wildcard-conditions-heavy");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(join(cwd, "node_modules", "@dx", "wild", "features"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "@dx", "wild", "bad"), { recursive: true });
  mkdirSync(join(cwd, "local"), { recursive: true });
  mkdirSync(join(cwd, "bad"), { recursive: true });

  const wildcardFeatureCount = 128;
  const conditionKeyCount = 16;
  const conditionalTarget = (ok: string, bad: string) => {
    const target: Record<string, string> = {};
    for (let i = 0; i < conditionKeyCount; i += 1) {
      target[`dx-condition-${i}`] = bad;
    }
    target.bun = ok;
    target.default = bad;
    return target;
  };

  writeJson(join(cwd, "package.json"), {
    type: "module",
    imports: {
      "#tool/*": conditionalTarget("./local/*.ts", "./bad/*.ts"),
    },
  });

  const packageRoot = join(cwd, "node_modules", "@dx", "wild");
  writeJson(join(packageRoot, "package.json"), {
    name: "@dx/wild",
    version: "1.0.0",
    type: "module",
    exports: {
      "./feature/*": conditionalTarget("./features/*.ts", "./bad/*.ts"),
    },
  });

  let expectedTotal = 0;
  for (let i = 0; i < wildcardFeatureCount; i += 1) {
    writeFileSync(join(packageRoot, "features", `${i}.ts`), `export default ${i + 100};\n`);
    writeFileSync(join(packageRoot, "bad", `${i}.ts`), `export default -${i + 100};\n`);
    writeFileSync(join(cwd, "local", `${i}.ts`), `export default ${i + 500};\n`);
    writeFileSync(join(cwd, "bad", `${i}.ts`), `export default -${i + 500};\n`);
    expectedTotal += i + 100 + i + 500;
  }
  for (let i = 0; i < 90000; i += 1) {
    expectedTotal = (expectedTotal + ((i * 23) ^ 3)) | 0;
  }

  writeFileSync(
    join(cwd, "entry.ts"),
    [
      ...Array.from({ length: wildcardFeatureCount }, (_, i) => `import feature${i} from "@dx/wild/feature/${i}";`),
      ...Array.from({ length: wildcardFeatureCount }, (_, i) => `import tool${i} from "#tool/${i}";`),
      "let total = 0;",
      ...Array.from({ length: wildcardFeatureCount }, (_, i) => `total += feature${i} + tool${i};`),
      "for (let i = 0; i < 90000; i += 1) total = (total + ((i * 23) ^ 3)) | 0;",
      'console.log("resolver-wildcard:" + total);',
      "",
    ].join("\n"),
  );

  return {
    name: "resolver-wildcard-conditions-heavy",
    rows: [12, 14, 19, 20, 25],
    description: "Package exports/imports dominated by wildcard expansion and condition-map selection.",
    expectedOutput: `resolver-wildcard:${expectedTotal}`,
    run: (target) => timedSpawn(target, ["entry.ts"], cwd),
  };
}

function prepareTsconfigPaths(): PreparedScenario {
  const cwd = join(workRoot, "tsconfig-paths-runtime");
  rmSync(cwd, { recursive: true, force: true });

  const paths: Record<string, string[]> = {
    "@exact": ["src/lib/exact.ts"],
  };
  mkdirSync(join(cwd, "src", "lib"), { recursive: true });
  writeFileSync(join(cwd, "src", "lib", "exact.ts"), "export default 11;\n");

  const groupCount = 12;
  const modulesPerGroup = 24;
  for (let group = 0; group < groupCount; group += 1) {
    paths[`@lib${group}/*`] = [`src/lib-${group}/*.ts`, `src/fallback-${group}/*.ts`];
    mkdirSync(join(cwd, "src", `lib-${group}`), { recursive: true });
    mkdirSync(join(cwd, "src", `fallback-${group}`), { recursive: true });
    for (let i = 0; i < modulesPerGroup; i += 1) {
      const value = group * 1000 + i * 3 + 1;
      writeFileSync(join(cwd, "src", `lib-${group}`, `mod-${i}.ts`), `export default ${value};\n`);
      writeFileSync(join(cwd, "src", `fallback-${group}`, `mod-${i}.ts`), `export default -${value};\n`);
    }
  }
  writeJson(join(cwd, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths,
    },
  });
  writeJson(join(cwd, "package.json"), { type: "module" });
  let expectedTotal = 11;
  for (let group = 0; group < groupCount; group += 1) {
    for (let i = 0; i < modulesPerGroup; i += 1) {
      expectedTotal += group * 1000 + i * 3 + 1;
    }
  }
  writeFileSync(
    join(cwd, "entry.ts"),
    [
      'import exact from "@exact";',
      ...Array.from({ length: groupCount }, (_, group) =>
        Array.from(
          { length: modulesPerGroup },
          (_, i) => `import mod${group}_${i} from "@lib${group}/mod-${i}";`,
        ).join("\n"),
      ),
      "let total = exact;",
      ...Array.from({ length: groupCount }, (_, group) =>
        Array.from({ length: modulesPerGroup }, (_, i) => `total += mod${group}_${i};`).join("\n"),
      ),
      "console.log('tsconfig:' + total);",
      "",
    ].join("\n"),
  );

  return {
    name: "tsconfig-paths-runtime",
    rows: [8, 14],
    description: "Runtime TypeScript imports through exact and wildcard tsconfig paths.",
    expectedOutput: `tsconfig:${expectedTotal}`,
    run: (target) => timedSpawn(target, ["entry.ts"], cwd),
  };
}

function prepareTsconfigExactPaths(): PreparedScenario {
  const cwd = join(workRoot, "tsconfig-paths-exact-runtime");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(join(cwd, "src", "exact"), { recursive: true });

  const exactPathCount = 192;
  const paths: Record<string, string[]> = {};
  let expectedTotal = 0;
  for (let i = 0; i < exactPathCount; i += 1) {
    paths[`@exact${i}`] = [`src/exact/${i}.ts`];
    writeFileSync(join(cwd, "src", "exact", `${i}.ts`), `export default ${i + 17};\n`);
    expectedTotal += i + 17;
  }
  writeJson(join(cwd, "tsconfig.json"), { compilerOptions: { baseUrl: ".", paths } });
  writeJson(join(cwd, "package.json"), { type: "module" });
  writeFileSync(
    join(cwd, "entry.ts"),
    [
      ...Array.from({ length: exactPathCount }, (_, i) => `import exact${i} from "@exact${i}";`),
      "let total = 0;",
      ...Array.from({ length: exactPathCount }, (_, i) => `total += exact${i};`),
      "console.log('tsconfig-exact:' + total);",
      "",
    ].join("\n"),
  );

  return {
    name: "tsconfig-paths-exact-runtime",
    rows: [8, 14],
    description: "Runtime TypeScript imports through exact-only tsconfig paths.",
    expectedOutput: `tsconfig-exact:${expectedTotal}`,
    run: (target) => timedSpawn(target, ["entry.ts"], cwd),
  };
}

function prepareTsconfigWildcardPaths(): PreparedScenario {
  const cwd = join(workRoot, "tsconfig-paths-wildcard-runtime");
  rmSync(cwd, { recursive: true, force: true });

  const groupCount = 14;
  const modulesPerGroup = 24;
  const paths: Record<string, string[]> = {};
  let expectedTotal = 0;
  for (let group = 0; group < groupCount; group += 1) {
    paths[`@wild${group}/*`] = [`src/wild-${group}/*.ts`];
    mkdirSync(join(cwd, "src", `wild-${group}`), { recursive: true });
    for (let i = 0; i < modulesPerGroup; i += 1) {
      const value = group * 1000 + i + 31;
      writeFileSync(join(cwd, "src", `wild-${group}`, `mod-${i}.ts`), `export default ${value};\n`);
      expectedTotal += value;
    }
  }
  writeJson(join(cwd, "tsconfig.json"), { compilerOptions: { baseUrl: ".", paths } });
  writeJson(join(cwd, "package.json"), { type: "module" });
  writeFileSync(
    join(cwd, "entry.ts"),
    [
      ...Array.from({ length: groupCount }, (_, group) =>
        Array.from({ length: modulesPerGroup }, (_, i) => `import mod${group}_${i} from "@wild${group}/mod-${i}";`).join("\n"),
      ),
      "let total = 0;",
      ...Array.from({ length: groupCount }, (_, group) =>
        Array.from({ length: modulesPerGroup }, (_, i) => `total += mod${group}_${i};`).join("\n"),
      ),
      "console.log('tsconfig-wildcard:' + total);",
      "",
    ].join("\n"),
  );

  return {
    name: "tsconfig-paths-wildcard-runtime",
    rows: [8, 14],
    description: "Runtime TypeScript imports through wildcard-only tsconfig paths.",
    expectedOutput: `tsconfig-wildcard:${expectedTotal}`,
    run: (target) => timedSpawn(target, ["entry.ts"], cwd),
  };
}

function prepareTsconfigFallbackPaths(): PreparedScenario {
  const cwd = join(workRoot, "tsconfig-paths-fallback-runtime");
  rmSync(cwd, { recursive: true, force: true });

  const groupCount = 10;
  const modulesPerGroup = 24;
  const paths: Record<string, string[]> = {};
  let expectedTotal = 0;
  for (let group = 0; group < groupCount; group += 1) {
    paths[`@fallback${group}/*`] = [`src/missing-${group}/*.ts`, `src/fallback-${group}/*.ts`];
    mkdirSync(join(cwd, "src", `fallback-${group}`), { recursive: true });
    for (let i = 0; i < modulesPerGroup; i += 1) {
      const value = group * 1000 + i * 5 + 41;
      writeFileSync(join(cwd, "src", `fallback-${group}`, `mod-${i}.ts`), `export default ${value};\n`);
      expectedTotal += value;
    }
  }
  writeJson(join(cwd, "tsconfig.json"), { compilerOptions: { baseUrl: ".", paths } });
  writeJson(join(cwd, "package.json"), { type: "module" });
  writeFileSync(
    join(cwd, "entry.ts"),
    [
      ...Array.from({ length: groupCount }, (_, group) =>
        Array.from(
          { length: modulesPerGroup },
          (_, i) => `import mod${group}_${i} from "@fallback${group}/mod-${i}";`,
        ).join("\n"),
      ),
      "let total = 0;",
      ...Array.from({ length: groupCount }, (_, group) =>
        Array.from({ length: modulesPerGroup }, (_, i) => `total += mod${group}_${i};`).join("\n"),
      ),
      "console.log('tsconfig-fallback:' + total);",
      "",
    ].join("\n"),
  );

  return {
    name: "tsconfig-paths-fallback-runtime",
    rows: [8, 14],
    description: "Runtime TypeScript imports that miss first tsconfig targets and resolve through fallback targets.",
    expectedOutput: `tsconfig-fallback:${expectedTotal}`,
    run: (target) => timedSpawn(target, ["entry.ts"], cwd),
  };
}

function prepareGeneratedAliases(): PreparedScenario {
  const cwd = join(workRoot, "generated-alias-test-runner");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  writeJson(join(cwd, "package.json"), { type: "module" });
  writeFileSync(
    join(cwd, "alias-runtime.test.ts"),
    `
import { expect, test } from "vitest";
import { readFileSync as bareRead } from "fs";
import { readFileSync as prefixedRead } from "node:fs";
import pathBare from "path";
import pathPrefixed from "node:path";
import { argv } from "process";

test("aliases resolve", () => {
  expect(typeof bareRead).toBe("function");
  expect(bareRead).toBe(prefixedRead);
  expect(pathBare.sep).toBe(pathPrefixed.sep);
  expect(Array.isArray(argv)).toBe(true);
});
`,
  );
  writeFileSync(
    join(cwd, "jest-runtime.test.ts"),
    `
import { expect, test } from "@jest/globals";

test("jest globals alias resolves", () => {
  expect(21 * 2).toBe(42);
});
`,
  );

  return {
    name: "generated-alias-test-runner",
    rows: [9],
    description: "bun:test aliases plus Node builtin alias resolution.",
    run: (target) =>
      timedSpawn(target, ["test", "--timeout", "10000", "alias-runtime.test.ts", "jest-runtime.test.ts"], cwd, {}, normalizeTestOutput),
  };
}

function prepareRuntimeTranspilerCache(): PreparedScenario {
  const cwd = join(workRoot, "runtime-transpiler-cache-hit");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const padding = Array.from({ length: 6000 }, (_, index) => `export const pad_${index}: number = ${index};`).join("\n");
  writeFileSync(
    join(cwd, "cache-entry.ts"),
    `
${padding}
const total = pad_41 + pad_999 + 17;
console.log("cache:" + total);
`,
  );

  return {
    name: "runtime-transpiler-cache-hit",
    rows: [22],
    description: "Second-run TypeScript runtime transpiler cache hit with per-binary cache directories.",
    run: (target, sampleIndex) => {
      const cacheDir = join(cwd, `.cache-${target.name}-${sampleIndex}`);
      rmSync(cacheDir, { recursive: true, force: true });
      mkdirSync(cacheDir, { recursive: true });
      const env = {
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: cacheDir,
        BUN_DEBUG_ENABLE_RESTORE_FROM_TRANSPILER_CACHE: "1",
      };
      timedSpawn(target, ["cache-entry.ts"], cwd, env);
      const before = cacheSignature(cacheDir, ".pile");
      if (before.count === 0) {
        throw new Error(`${target.name} did not create a transpiler cache .pile before hit measurement`);
      }
      const hit = timedSpawn(target, ["cache-entry.ts"], cwd, env);
      const after = cacheSignature(cacheDir, ".pile");
      if (before.signature !== after.signature) {
        throw new Error(`${target.name} rewrote transpiler cache during hit measurement`);
      }
      return {
        ms: hit.ms,
        output: `${hit.output};cachePile=present;cacheRewriteStable=true`,
      };
    },
  };
}

function prepareBundlerMinifySourcemap(): PreparedScenario {
  const cwd = join(workRoot, "bundler-minify-sourcemap");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeJson(join(cwd, "package.json"), { type: "module" });
  for (let i = 0; i < 96; i += 1) {
    const numbers = Array.from({ length: 16 }, (_, j) => (i + 1) * (j + 3) + 0.125).join(", ");
    writeFileSync(
      join(cwd, "src", `module-${i}.ts`),
      `
export function value_${i}(seed: number): number {
  const values = [${numbers}];
  let total = seed;
  for (const value of values) total += value;
  return total;
}
`,
    );
  }
  writeFileSync(
    join(cwd, "entry.ts"),
    [
      ...Array.from({ length: 96 }, (_, i) => `import { value_${i} } from "./src/module-${i}.ts";`),
      "let total = 0;",
      ...Array.from({ length: 96 }, (_, i) => `total += value_${i}(${i});`),
      "console.log('bundle:' + total.toFixed(3));",
      "",
    ].join("\n"),
  );

  return {
    name: "bundler-minify-sourcemap",
    rows: [6, 10, 13, 23, 24, 25],
    description: "Bundle/minify/sourcemap workload over many TS modules and numeric literals.",
    run: (target, sampleIndex) => {
      const outfileRelative = `bundle-${target.name}-${sampleIndex}.js`;
      const outfile = join(cwd, outfileRelative);
      return timedSpawn(
        target,
        ["build", "entry.ts", "--target", "bun", "--outfile", outfileRelative, "--sourcemap", "--minify"],
        cwd,
        {},
        (result) => normalizeBuildIntegrityOutput(target, result, outfile, cwd),
      );
    },
  };
}

function prepareWorkspaceInstall(): PreparedScenario {
  const template = join(workRoot, "workspace-install-lockfile-template");
  rmSync(template, { recursive: true, force: true });
  mkdirSync(join(template, "packages"), { recursive: true });
  const dependencies: Record<string, string> = {};
  const workspacePackages = Array.from({ length: 36 }, (_, i) => `pkg-${String(i).padStart(2, "0")}`);
  for (const [index, name] of workspacePackages.entries()) {
    dependencies[name] = "workspace:*";
    const packageDir = join(template, "packages", name);
    mkdirSync(packageDir, { recursive: true });
    writeJson(join(packageDir, "package.json"), {
      name,
      version: "1.0.0",
      type: "module",
      dependencies: index > 0 ? { [workspacePackages[index - 1]]: "workspace:*" } : {},
      peerDependencies: index > 1 ? { [workspacePackages[index - 2]]: "1.0.0" } : {},
    });
    writeFileSync(join(packageDir, "index.ts"), `export const value = ${index};\n`);
  }
  writeJson(join(template, "package.json"), {
    name: "workspace-install-lockfile",
    private: true,
    workspaces: ["packages/*"],
    dependencies,
    trustedDependencies: ["@biomejs/biome", "esbuild", "sharp"],
  });

  return {
    name: "workspace-install-lockfile",
    rows: [7, 15, 27],
    description: "Offline workspace install lockfile generation across many local packages.",
    run: (target, sampleIndex) => {
      const cwd = join(workRoot, "workspace-install-runs", `${target.name}-${sampleIndex}`);
      rmSync(cwd, { recursive: true, force: true });
      cpSync(template, cwd, { recursive: true });
      return timedSpawn(
        target,
        ["install", "--lockfile-only", "--ignore-scripts", "--cache-dir", join(cwd, ".bun-cache")],
        cwd,
        {},
        (result) => normalizeWorkspaceInstallIntegrity(result, cwd, workspacePackages),
      );
    },
  };
}

function prepareDefaultTrustedDeps(): PreparedScenario {
  const cwd = join(workRoot, "trusted-deps-default-table");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  writeJson(join(cwd, "package.json"), { private: true, name: "trusted-deps-default-table" });

  return {
    name: "trusted-deps-default-table",
    rows: [27],
    description: "Generated default trusted dependency table command.",
    run: (target) => timedSpawn(target, ["pm", "default-trusted"], cwd, {}, normalizeDefaultTrustedDeps),
  };
}

function prepareWhichPathResolution(): PreparedScenario {
  const cwd = join(workRoot, "which-path-resolution");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const pathParts: string[] = [];
  for (let i = 0; i < 96; i += 1) {
    const dir = join(cwd, "path-segments", `segment-${String(i).padStart(2, "0")}`);
    mkdirSync(dir, { recursive: true });
    pathParts.push(dir);
  }
  const binName = process.platform === "win32" ? "dx-tool.exe" : "dx-tool";
  const binPath = join(pathParts[pathParts.length - 1], binName);
  writeFileSync(binPath, process.platform === "win32" ? "" : "#!/bin/sh\nexit 0\n");
  const iterations = whichPathIterations;
  writeFileSync(
    join(cwd, "which-entry.ts"),
    `
const PATH = ${JSON.stringify(pathParts.join(process.platform === "win32" ? ";" : ":"))};
const expected = ${JSON.stringify(binPath)};
const normalizePath = (value: string) => value.replaceAll("/", "\\\\").toLowerCase();
let found = "";
for (let i = 0; i < ${iterations}; i += 1) {
  const current = Bun.which("dx-tool", { PATH });
  if (!current) throw new Error("missing dx-tool");
  found = current;
}
if (normalizePath(found) !== normalizePath(expected)) {
  throw new Error("wrong dx-tool path: " + found);
}
console.log("which:exact");
`,
  );

  return {
    name: "which-path-resolution",
    rows: [26],
    description: "Repeated Bun.which lookups across a long Windows PATH with the hit near the end.",
    run: (target) => timedSpawn(target, ["which-entry.ts"], cwd),
  };
}

function prepareLocalTarballInstall(): PreparedScenario {
  const template = join(workRoot, "local-tarball-install-template");
  rmSync(template, { recursive: true, force: true });
  mkdirSync(template, { recursive: true });
  const packageNames = Array.from({ length: 12 }, (_, index) => `tarball-pkg-${index}`);
  const dependencies: Record<string, string> = {};
  for (const [index, packageName] of packageNames.entries()) {
    const tarballName = `${packageName}-1.0.0.tgz`;
    dependencies[packageName] = `file:./${tarballName}`;
    writeFileSync(
      join(template, tarballName),
      createGzipTarball([
        {
          name: "package/package.json",
          body: JSON.stringify({ name: packageName, version: "1.0.0", main: "index.js" }, null, 2) + "\n",
        },
        {
          name: "package/index.js",
          body: `module.exports = ${index + 42};\n`,
        },
        {
          name: "package/payload.bin",
          body: deterministicBytes(index + 1, 64 * 1024),
        },
      ]),
    );
  }
  writeJson(join(template, "package.json"), {
    name: "local-tarball-install",
    private: true,
    dependencies,
  });

  return {
    name: "local-tarball-install",
    rows: [28],
    description: "Offline file: tgz dependency install to exercise gzip tarball extraction.",
    run: (target, sampleIndex) => {
      const cwd = join(workRoot, "local-tarball-install-runs", `${target.name}-${sampleIndex}`);
      rmSync(cwd, { recursive: true, force: true });
      cpSync(template, cwd, { recursive: true });
      return timedSpawn(
        target,
        ["install", "--ignore-scripts", "--cache-dir", join(cwd, ".bun-cache")],
        cwd,
        {},
        (result) => normalizeTarballInstallIntegrity(target, result, cwd, packageNames),
      );
    },
  };
}

function normalizeTestOutput(result: SpawnSyncReturns<string>): string {
  const text = defaultNormalize(result);
  const passes = text.match(/([0-9]+)\s+pass/);
  const fails = text.match(/([0-9]+)\s+fail/);
  if (!passes || !fails) {
    throw new Error(`Could not parse bun:test pass/fail counts from output:\n${text}`);
  }

  if (passes[1] !== "2" || fails[1] !== "0") {
    throw new Error(`Alias test scenario expected pass=2;fail=0, got pass=${passes[1]};fail=${fails[1]}`);
  }

  return `pass=${passes[1]};fail=${fails[1]}`;
}

function normalizeBuildOutput(result: SpawnSyncReturns<string>): string {
  return defaultNormalize(result)
    .replace(/bundle-[^\s]+\.js/g, "bundle.js")
    .replace(/[0-9.]+\s*KB/g, "<size>")
    .replace(/[0-9.]+\s*MB/g, "<size>");
}

function normalizeBuildIntegrityOutput(
  target: BunTarget,
  result: SpawnSyncReturns<string>,
  outfile: string,
  cwd: string,
): string {
  const mapPath = `${outfile}.map`;
  if (!existsSync(outfile)) {
    throw new Error(`${target.name} build did not write bundle: ${outfile}`);
  }
  if (!existsSync(mapPath)) {
    throw new Error(`${target.name} build did not write sourcemap: ${mapPath}`);
  }

  const bundle = readFileSync(outfile, "utf8");
  const sourcemap = readFileSync(mapPath, "utf8");
  const runOutput = runAndRead(target.path, [outfile], cwd, envForTarget(target));
  const sourceMap = JSON.parse(sourcemap) as { version?: number; sources?: unknown[]; mappings?: string };
  const sourceCount = Array.isArray(sourceMap.sources) ? sourceMap.sources.length : 0;
  const hasMappings = typeof sourceMap.mappings === "string" && sourceMap.mappings.length > 0;
  const bundleHasSourceMap = bundle.includes("sourceMappingURL=");

  if (runOutput !== "bundle:786960.000") {
    throw new Error(`${target.name} bundle run output mismatch: ${runOutput}`);
  }
  if (!bundleHasSourceMap) {
    throw new Error(`${target.name} bundle is missing sourceMappingURL comment`);
  }
  if (sourceMap.version !== 3) {
    throw new Error(`${target.name} sourcemap version mismatch: ${sourceMap.version ?? "missing"}`);
  }
  if (sourceCount !== 97) {
    throw new Error(`${target.name} sourcemap source count mismatch: ${sourceCount}`);
  }
  if (!hasMappings) {
    throw new Error(`${target.name} sourcemap mappings are empty`);
  }

  return [
    `build=${normalizeBuildOutput(result)}`,
    `run=${runOutput}`,
    `bundleHasSourceMap=${bundleHasSourceMap}`,
    `sourceMapVersion=${sourceMap.version ?? "missing"}`,
    `sourceCount=${sourceCount}`,
    `hasMappings=${hasMappings}`,
  ].join(";");
}

function normalizeInstallOutput(result: SpawnSyncReturns<string>): string {
  return defaultNormalize(result)
    .replace(/^warn: Slow filesystem detected\.[^\n]*\n?/gm, "")
    .replace(/^If [^\n]*BUN_INSTALL_CACHE_DIR[^\n]*\n?/gm, "")
    .replace(/Saved lockfile/g, "Saved lockfile")
    .replace(/Checked [0-9]+ installs/g, "Checked <n> installs");
}

function normalizeWorkspaceInstallIntegrity(
  result: SpawnSyncReturns<string>,
  cwd: string,
  workspacePackages: readonly string[],
): string {
  const lockfile = readInstallLockfile(cwd);
  const lockText = lockfile.bytes.toString("utf8");
  const missingPackages = workspacePackages.filter((name) => !lockText.includes(name));
  if (missingPackages.length > 0) {
    throw new Error(`workspace install lockfile is missing packages: ${missingPackages.join(", ")}`);
  }

  return [
    `install=${normalizeInstallOutput(result)}`,
    `lockfile=${lockfile.name}`,
    `lockSha256=${sha256(lockfile.bytes)}`,
    `workspacePackages=${workspacePackages.length}`,
    `trustedDepsInput=${trustedDependencyCount(cwd)}`,
  ].join(";");
}

function normalizeDefaultTrustedDeps(result: SpawnSyncReturns<string>): string {
  const text = defaultNormalize(result);
  const count = Number(text.match(/Default trusted dependencies \((\d+)\):/)?.[1] ?? 0);
  if (count < 100 || !text.includes(" - esbuild") || !text.includes(" - sharp")) {
    throw new Error("default trusted dependency output is missing expected entries");
  }
  return `defaultTrusted=${count};hasEsbuild=true;hasSharp=true`;
}

function normalizeTarballInstallIntegrity(
  target: BunTarget,
  result: SpawnSyncReturns<string>,
  cwd: string,
  packageNames: readonly string[],
): string {
  const lockfile = readInstallLockfile(cwd);
  const missingPackages: string[] = [];
  const indexHashes: string[] = [];
  for (const packageName of packageNames) {
    const packageJsonPath = join(cwd, "node_modules", packageName, "package.json");
    const packageIndexPath = join(cwd, "node_modules", packageName, "index.js");
    const packagePayloadPath = join(cwd, "node_modules", packageName, "payload.bin");
    if (!existsSync(packageJsonPath) || !existsSync(packageIndexPath) || !existsSync(packagePayloadPath)) {
      missingPackages.push(packageName);
      continue;
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
    if (packageJson.name !== packageName || packageJson.version !== "1.0.0") {
      throw new Error(`${target.name} materialized wrong package metadata for ${packageName}`);
    }
    indexHashes.push(sha256(readFileSync(packageIndexPath)));
  }

  if (missingPackages.length > 0) {
    throw new Error(`${target.name} tarball install did not materialize: ${missingPackages.join(", ")}`);
  }

  const requireOutput = runAndRead(
    target.path,
    [
      "-e",
      `const names=${JSON.stringify(packageNames)}; let total = 0; for (const name of names) total += require(name); console.log(total);`,
    ],
    cwd,
    envForTarget(target),
  );
  return [
    `install=${normalizeInstallOutput(result)}`,
    `lockfile=${lockfile.name}`,
    `lockSha256=${sha256(lockfile.bytes)}`,
    `packages=${packageNames.length}`,
    `indexSha256=${sha256(indexHashes.join("|"))}`,
    `require=${requireOutput}`,
  ].join(";");
}

function readInstallLockfile(cwd: string): { name: string; bytes: Buffer } {
  for (const name of ["bun.lock", "bun.lockb"]) {
    const path = join(cwd, name);
    if (existsSync(path)) {
      return { name, bytes: readFileSync(path) };
    }
  }
  throw new Error(`install did not write a Bun lockfile in ${cwd}`);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cacheSignature(root: string, extension: string): { count: number; bytes: number; signature: string } {
  const files = listFiles(root).filter((path) => path.endsWith(extension)).sort();
  let bytes = 0;
  const parts: string[] = [];
  for (const path of files) {
    const stat = statSync(path);
    bytes += stat.size;
    parts.push(`${relative(root, path).replaceAll("\\", "/")}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
  }
  return {
    count: files.length,
    bytes,
    signature: parts.join("|"),
  };
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function trustedDependencyCount(cwd: string): number {
  const rootPackage = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
    trustedDependencies?: unknown;
  };
  return Array.isArray(rootPackage.trustedDependencies) ? rootPackage.trustedDependencies.length : 0;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createGzipTarball(entries: Array<{ name: string; body: string | Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body);
    chunks.push(tarHeader(entry.name, body.length));
    chunks.push(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function deterministicBytes(seed: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const encoded = checksum.toString(8).padStart(6, "0");
  header.write(encoded, 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  buffer.write(encoded.slice(-length + 1), offset, "ascii");
  buffer[offset + length - 1] = 0;
}

function buildCoverageSummary() {
  const planRows = readPlanRows();
  return Array.from({ length: 30 }, (_, index) => {
    const row = index + 1;
    const evidence = rowEvidence[row];
    if (!evidence) {
      throw new Error(`PLAN row ${row} has no rowEvidence entry`);
    }
    const presentContracts = evidence.contracts.filter((contract) => contractExists(contract));
    const missingContracts = evidence.contracts.filter((contract) => !contractExists(contract));
    const planOptimization = planRows.get(row);
    if (!planOptimization) {
      throw new Error(`PLAN row ${row} is missing from the Best 30 Options table`);
    }

    return {
      row,
      planOptimization,
      contracts: evidence.contracts,
      presentContracts,
      missingContracts,
      benchmarkScenarios: evidence.benchmarkScenarios,
      benchmarkEvidenceKind: benchmarkEvidenceKind(evidence),
      note: evidence.note,
      hasContractEvidence: evidence.contracts.length > 0 && missingContracts.length === 0,
      hasBenchmarkScenario: evidence.benchmarkScenarios.length > 0,
    };
  });
}

function benchmarkEvidenceKind(evidence: { benchmarkScenarios: string[]; note: string }): "direct" | "indirect" | "source-only" {
  if (evidence.benchmarkScenarios.length === 0) {
    return "source-only";
  }

  return /\bindirect(?:ly)?\b|source-proven|source evidence|applies pressure|runtime pressure/i.test(evidence.note)
    ? "indirect"
    : "direct";
}

function readPlanRows(): Map<number, string> {
  const planPath = join(repoRoot, "PLAN.md");
  const plan = readFileSync(planPath, "utf8");
  const start = plan.indexOf("## Best 30 Options");
  const end = plan.indexOf("## Implementation Status Snapshot");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("PLAN.md is missing the Best 30 Options section boundary");
  }

  const rows = new Map<number, string>();
  const section = plan.slice(start, end);
  for (const match of section.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/gm)) {
    const row = Number(match[1]);
    if (row >= 1 && row <= 30) {
      rows.set(row, match[2].trim());
    }
  }

  if (rows.size !== 30) {
    throw new Error(`PLAN.md Best 30 Options table has ${rows.size} rows, expected 30`);
  }

  return rows;
}

function contractExists(contract: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(contract) || contract.startsWith("\\\\") || contract.startsWith("//")) {
    return existsSync(contract);
  }

  return existsSync(join(repoRoot, contract));
}

function validateCoverageMapping(coverageRows: ReturnType<typeof buildCoverageSummary>): void {
  const rowsByScenario = new Map(scenarios.map((scenario) => [scenario.name, new Set(scenario.rows)]));
  for (const row of Object.keys(rowEvidence).map(Number)) {
    if (!Number.isInteger(row) || row < 1 || row > 30) {
      throw new Error(`Unexpected rowEvidence key: ${row}`);
    }
  }

  for (const coverage of coverageRows) {
    if (coverage.missingContracts.length > 0) {
      throw new Error(`PLAN row ${coverage.row} has missing contract evidence: ${coverage.missingContracts.join(", ")}`);
    }

    if (!coverage.hasContractEvidence && !coverage.hasBenchmarkScenario) {
      throw new Error(`PLAN row ${coverage.row} has no mapped evidence`);
    }

    for (const scenario of coverage.benchmarkScenarios) {
      const rows = rowsByScenario.get(scenario);
      if (!rows) {
        throw new Error(`PLAN row ${coverage.row} references unknown benchmark scenario: ${scenario}`);
      }
      if (!rows.has(coverage.row)) {
        throw new Error(`PLAN row ${coverage.row} references ${scenario}, but that scenario does not list the row`);
      }
    }
  }
}

function buildDeltas(
  items: ScenarioResult[],
  targetList: readonly BunTarget[],
  comparison: ReturnType<typeof buildComparisonSummary>,
) {
  const deltas = [];
  const [baselineTarget, candidateTarget] = targetList;
  const scenarios = [...new Set(items.map((item) => item.scenario))];
  for (const scenario of scenarios) {
    const baseline = items.find((item) => item.scenario === scenario && item.target === baselineTarget.name);
    const candidate = items.find((item) => item.scenario === scenario && item.target === candidateTarget.name);
    if (!baseline || !candidate) continue;
    const candidateFasterPct = round3(((baseline.trimmedMeanMs - candidate.trimmedMeanMs) / baseline.trimmedMeanMs) * 100);
    deltas.push({
      scenario,
      rows: candidate.rows,
      baselineTarget: baselineTarget.name,
      candidateTarget: candidateTarget.name,
      baselineTrimmedMeanMs: baseline.trimmedMeanMs,
      candidateTrimmedMeanMs: candidate.trimmedMeanMs,
      baselineMedianMs: baseline.medianMs,
      candidateMedianMs: candidate.medianMs,
      baselineIqrMs: baseline.iqrMs,
      candidateIqrMs: candidate.iqrMs,
      candidateFasterPct,
      signal: classifyDelta(baseline, candidate, candidateFasterPct, comparison),
    });
  }
  return deltas;
}

function classifyDelta(
  baseline: ScenarioResult,
  candidate: ScenarioResult,
  candidateFasterPct: number,
  comparison: ReturnType<typeof buildComparisonSummary>,
): BenchmarkSignal {
  if (Math.min(baseline.runs, candidate.runs) < minRankableRuns) {
    return "underpowered";
  }
  if (comparison.kind === "same-binary-aa") {
    return "noisy";
  }

  const largestCv = Math.max(baseline.cvPct, candidate.cvPct);
  const largestIqrPct = Math.max(
    baseline.medianMs > 0 ? (baseline.iqrMs / baseline.medianMs) * 100 : 0,
    candidate.medianMs > 0 ? (candidate.iqrMs / candidate.medianMs) * 100 : 0,
  );
  const largestMaxMedianRatio = Math.max(
    baseline.medianMs > 0 ? baseline.maxMs / baseline.medianMs : 1,
    candidate.medianMs > 0 ? candidate.maxMs / candidate.medianMs : 1,
  );

  if (largestMaxMedianRatio >= 4 || largestCv >= 60 || largestIqrPct >= 35) {
    return "unstable";
  }
  if (Math.abs(candidateFasterPct) < 3 || largestCv >= 20 || largestIqrPct >= 15) {
    return "noisy";
  }

  return "signal";
}

function buildComparisonSummary(targetList: readonly BunTarget[]) {
  const [baseline, candidate] = targetList;
  const sameVersion = baseline.version === candidate.version;
  const sameRevision = baseline.revision === candidate.revision;
  const samePath = normalizedPath(baseline.path) === normalizedPath(candidate.path);
  const sameEnv = envOverridesEqual(baseline.envOverrides, candidate.envOverrides);
  const sameBinary = samePath && sameRevision;
  const sameBinaryAa = sameBinary && sameEnv;
  const sameBinaryWithEnv = sameBinary && !sameEnv;
  return {
    kind: sameBinaryAa ? "same-binary-aa" : sameBinaryWithEnv ? "same-binary-ab" : sameVersion ? "same-version" : "stable-vs-canary",
    sameVersion,
    sameRevision,
    samePath,
    sameEnv,
    proofLevel: sameBinaryAa
      ? "same-binary-noise-floor"
      : sameBinaryWithEnv
        ? "same-binary-env-ab"
        : sameVersion
          ? "version-comparison"
          : "exploratory-cross-version",
    note: sameBinaryAa
      ? `${baseline.name} and ${candidate.name} use the same binary/revision and identical env overrides. Treat deltas as local noise-floor evidence, not feature speed evidence.`
      : sameBinaryWithEnv
        ? `${baseline.name} and ${candidate.name} use the same binary/revision with different env overrides. Treat deltas as feature-toggle proof for only the selected flag path.`
        : sameVersion
        ? "Both binaries report the same Bun version; this is still not a same-base patch proof unless revisions share the same upstream commit."
        : `${baseline.name} reports ${baseline.version}; ${candidate.name} reports ${candidate.version}. Treat speed deltas as product-level stable-vs-canary evidence, not isolated DX-patch proof.`,
  };
}

function envOverridesEqual(a: NodeJS.ProcessEnv | undefined, b: NodeJS.ProcessEnv | undefined): boolean {
  const aEntries = Object.entries(a ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const bEntries = Object.entries(b ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (aEntries.length !== bEntries.length) return false;
  return aEntries.every(([key, value], index) => {
    const [otherKey, otherValue] = bEntries[index]!;
    return key === otherKey && value === otherValue;
  });
}

function formatTargetForConsole(target: BunTarget): string {
  const overrideKeys = Object.keys(target.envOverrides ?? {});
  const overrideLabel = overrideKeys.length > 0 ? ` env=${overrideKeys.join(",")}` : "";
  return `${target.revision} sha256=${target.sha256.slice(0, 16)} size=${target.sizeBytes}${overrideLabel}`;
}

function formatRankableDelta(delta: BenchmarkSummary["deltas"][number]): string {
  if (delta.signal === "signal") {
    return `${delta.candidateFasterPct}`;
  }

  return `unranked (${delta.signal}; raw ${delta.candidateFasterPct}%)`;
}

function renderConsoleSummary(summary: BenchmarkSummary, outputPaths?: BenchmarkOutputPaths): string {
  const lines = [
    `DX Bun feature benchmark (${summary.method})`,
    `comparison: ${summary.comparison.kind} (${summary.comparison.proofLevel}) - ${summary.comparison.note}`,
    `parent: ${summary.parentRunner.revision} (${summary.parentRunner.matchesOfficialPath ? "official parent" : `non-official parent: ${summary.parentRunner.execPath}`})`,
    `${summary.targets[0].name}: ${formatTargetForConsole(summary.targets[0])}`,
    `${summary.targets[1].name}: ${formatTargetForConsole(summary.targets[1])}`,
    "",
    "Rows marked underpowered, noisy, or unstable are not rankable; raw deltas are follow-up hints only.",
    "",
    `scenario | rows | signal | ${summary.targets[0].name} trimmed ms | ${summary.targets[1].name} trimmed ms | rankable delta`,
    "--- | --- | --- | ---: | ---: | ---",
  ];
  for (const delta of summary.deltas) {
    lines.push(
      `${delta.scenario} | ${delta.rows.join(",")} | ${delta.signal} | ${delta.baselineTrimmedMeanMs} | ${delta.candidateTrimmedMeanMs} | ${formatRankableDelta(delta)}`,
    );
  }
  lines.push("");
  lines.push(`results: ${relative(repoRoot, join(workRoot, "results-latest.json"))}`);
  lines.push(`summary: ${relative(repoRoot, join(workRoot, "summary.md"))}`);
  if (outputPaths) {
    lines.push(`snapshot results: ${relative(repoRoot, outputPaths.snapshotResults)}`);
    lines.push(`snapshot summary: ${relative(repoRoot, outputPaths.snapshotSummary)}`);
  }
  return lines.join("\n");
}

function renderMarkdownSummary(summary: BenchmarkSummary): string {
  const lines = [
    "# DX Bun Feature Benchmark",
    "",
    `Generated: ${summary.generatedAtUtc}`,
    "",
    `Method: ${summary.method}`,
    "",
    `Comparison: **${summary.comparison.kind}** (${summary.comparison.proofLevel}). ${summary.comparison.note}`,
    "",
    `Parent runner: \`${summary.parentRunner.execPath}\` reports \`${summary.parentRunner.revision}\`; official-parent match: **${summary.parentRunner.matchesOfficialPath}**.`,
    "",
    "| Target | Path | Revision | Version | SHA256 | Size bytes | mtime ms | Env override keys |",
    "| --- | --- | --- | --- | --- | ---: | ---: | --- |",
    ...summary.targets.map((target) => {
      const overrideKeys = Object.keys(target.envOverrides ?? {});
      return `| ${target.name} | \`${target.path}\` | \`${target.revision}\` | \`${target.version}\` | \`${target.sha256}\` | ${target.sizeBytes} | ${Math.round(target.mtimeMs)} | ${overrideKeys.join(", ") || "none"} |`;
    }),
    "",
    coverageTotalsLine(summary.coverage),
    "",
    "Rows marked underpowered, noisy, or unstable are not rankable; raw deltas are follow-up hints only.",
    "",
    `| Scenario | PLAN rows | Signal | ${summary.targets[0].name} trimmed mean ms | ${summary.targets[1].name} trimmed mean ms | ${summary.targets[0].name} median/IQR ms | ${summary.targets[1].name} median/IQR ms | Rankable delta |`,
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const delta of summary.deltas) {
    lines.push(
      `| ${delta.scenario} | ${delta.rows.join(", ")} | ${delta.signal} | ${delta.baselineTrimmedMeanMs} | ${delta.candidateTrimmedMeanMs} | ${delta.baselineMedianMs}/${delta.baselineIqrMs} | ${delta.candidateMedianMs}/${delta.candidateIqrMs} | ${formatRankableDelta(delta)} |`,
    );
  }
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push("| Row | PLAN optimization | Contracts | Contract presence | Runtime evidence | Benchmarks | Note |");
  lines.push("| ---: | --- | --- | --- | --- | --- | --- |");
  for (const coverage of summary.coverage) {
    const contractStatus = coverage.missingContracts.length > 0
      ? `missing: ${coverage.missingContracts.join("<br>")}`
      : `present: ${coverage.presentContracts.length}`;
    lines.push(
      `| ${coverage.row} | ${coverage.planOptimization} | ${coverage.contracts.join("<br>")} | ${contractStatus} | ${coverage.benchmarkEvidenceKind} | ${coverage.benchmarkScenarios.join("<br>") || "source/proof only"} | ${coverage.note} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function coverageTotalsLine(coverage: ReturnType<typeof buildCoverageSummary>): string {
  const runtimeRows = coverage.filter((row) => row.hasBenchmarkScenario).length;
  const directRows = coverage.filter((row) => row.benchmarkEvidenceKind === "direct").length;
  const indirectRows = coverage.filter((row) => row.benchmarkEvidenceKind === "indirect").length;
  const sourceOnlyRows = coverage.length - runtimeRows;
  return `Coverage shape: PLAN rows ${coverage.length}; direct runtime rows ${directRows}; indirect runtime rows ${indirectRows}; source/contract-only rows ${sourceOnlyRows}. Contract presence means the evidence file exists, not that this benchmark run executed it.`;
}

for (const target of targets) {
  const item = statSync(target.path);
  if (!item.isFile()) {
    throw new Error(`${target.name} Bun is not a file: ${target.path}`);
  }
}

if (readdirSync(workRoot).length === 0) {
  throw new Error("benchmark work root was not populated");
}
