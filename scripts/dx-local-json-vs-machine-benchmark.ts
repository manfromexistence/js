import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

type CaseName = "small" | "medium" | "large";
type TargetName = "local-json" | "local-machine";
type BenchmarkSignal = "signal" | "noisy" | "underpowered";

type CaseConfig = {
  name: CaseName;
  packageCount: number;
  packageJsonBytes: number;
};

type TargetConfig = {
  name: TargetName;
  env?: NodeJS.ProcessEnv;
};

type Sample = {
  ms: number;
  roundIndex: number;
  targetOrder: TargetName[];
};

type TargetSummary = {
  target: TargetName;
  trimmedMeanMs: number;
  medianMs: number;
  iqrMs: number;
  cvPct: number;
  minMs: number;
  maxMs: number;
  runs: number;
  warmups: number;
  signal: BenchmarkSignal;
  samplesMs: number[];
};

type ProofSummary = {
  target: TargetName;
  packagePathsSeen: number;
  parseAttempts: number;
  normalFileReads: number;
  machineHits: number;
  pathRefReads: number;
  pathOwnedReads: number;
  packedPayloadHits: number;
  sourceValidationReads: number;
};

type CaseResult = {
  case: CaseName;
  workRoot: string;
  packageCount: number;
  packageJsonBytesEach: number;
  packageJsonBytesTotal: number;
  machineBytesTotal: number;
  generationMsExcluded: number;
  proof: ProofSummary[];
  targets: TargetSummary[];
  delta: {
    baseline: "local-json";
    candidate: "local-machine";
    candidateVsBaselinePct: number;
    speedup: number;
    rankable: boolean;
    faster: TargetName | "inconclusive" | "unranked";
  };
};

type BenchmarkResult = {
  schema: "dx.local_json_vs_machine_benchmark.v1";
  generatedAtUtc: string;
  localBun: ReturnType<typeof inspectLocalBun>;
  repoProof: ReturnType<typeof inspectRepoProof>;
  generationExcludedFromTiming: true;
  processStartupExcludedFromTiming: true;
  workerExtension: "ts";
  runs: number;
  warmups: number;
  cases: CaseResult[];
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = join(repoRoot, ".tmp", "dx-local-json-vs-machine-bench");
const serializerManifest = process.env.DX_SERIALIZER_MANIFEST || "G:\\dx\\serializer\\Cargo.toml";
const runs = positiveIntegerEnv("DX_LOCAL_MACHINE_BENCH_RUNS", 40);
const warmups = positiveIntegerEnv("DX_LOCAL_MACHINE_BENCH_WARMUPS", 8);
const selectedCases = selectedCaseSetEnv("DX_LOCAL_MACHINE_BENCH_CASES");
const trimRatio = 0.1;
const minRankableRuns = 20;
const maxRankableCvPct = 20;
const maxRankableIqrMedianRatio = 0.3;
const minMeaningfulEffectPct = 3;
const benchmarkBaseProcessEnv = sanitizedBenchmarkEnv();
const localBunPath = resolveLocalBun();
const repoProof = inspectRepoProof(localBunPath);

const caseConfigs: CaseConfig[] = [
  { name: "small", packageCount: 64, packageJsonBytes: 2048 },
  { name: "medium", packageCount: 128, packageJsonBytes: 16384 },
  { name: "large", packageCount: 256, packageJsonBytes: 65536 },
].filter(config => !selectedCases || selectedCases.has(config.name));

const targets: TargetConfig[] = [
  {
    name: "local-json",
    env: { BUN_DX_MACHINE_CACHE_DISABLE: "1" },
  },
  {
    name: "local-machine",
  },
];

main();

function main(): void {
  assertInsideRepoTmp(workRoot);
  assertLocalBunAllowed(localBunPath);
  assertLocalProofFresh(repoProof);
  resetWorkRoot();

  const cases = caseConfigs.map(config => runCase(config));
  const result: BenchmarkResult = {
    schema: "dx.local_json_vs_machine_benchmark.v1",
    generatedAtUtc: new Date().toISOString(),
    localBun: inspectLocalBun(localBunPath),
    repoProof,
    generationExcludedFromTiming: true,
    processStartupExcludedFromTiming: true,
    workerExtension: "ts",
    runs,
    warmups,
    cases,
  };

  const resultPath = join(repoRoot, ".tmp", "dx-local-json-vs-machine-benchmark-results.json");
  const summaryPath = join(repoRoot, ".tmp", "dx-local-json-vs-machine-benchmark-summary.md");
  const snapshotRoot = join(repoRoot, ".tmp", "dx-local-json-vs-machine-benchmark-snapshots");
  mkdirSync(snapshotRoot, { recursive: true });
  const snapshotSlug = safeSnapshotPart(result.generatedAtUtc.replaceAll(/[-:.]/g, ""));
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
  writeFileSync(summaryPath, renderMarkdown(result));
  writeFileSync(join(snapshotRoot, `results-${snapshotSlug}.json`), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(snapshotRoot, `summary-${snapshotSlug}.md`), renderMarkdown(result));

  console.log(JSON.stringify(result, null, 2));
  console.error(`[dx-local-machine-bench] results: ${resultPath}`);
  console.error(`[dx-local-machine-bench] summary: ${summaryPath}`);
}

function runCase(config: CaseConfig): CaseResult {
  const caseRoot = join(workRoot, config.name);
  mkdirSync(caseRoot, { recursive: true });
  const packageJsonBytesTotal = generateCaseFixture(caseRoot, config);
  const generationStart = performance.now();
  generateMachineCache(caseRoot, config);
  const generationMsExcluded = round(performance.now() - generationStart);
  const machineBytesTotal = sumGeneratedMachineBytes(caseRoot);
  const proof = targets.map(target => runProof(caseRoot, config, target));

  const samplesByTarget = new Map<TargetName, Sample[]>();
  for (const target of targets) {
    samplesByTarget.set(target.name, []);
  }

  for (let warmupIndex = 0; warmupIndex < warmups; warmupIndex++) {
    for (const target of orderedTargetsForSample(warmupIndex)) {
      runWorker(caseRoot, config, target, warmupIndex, orderedTargetNames(warmupIndex));
    }
  }

  for (let sampleIndex = 0; sampleIndex < runs; sampleIndex++) {
    const targetOrder = orderedTargetNames(sampleIndex);
    for (const target of orderedTargetsForSample(sampleIndex)) {
      samplesByTarget.get(target.name)!.push(runWorker(caseRoot, config, target, sampleIndex, targetOrder));
    }
  }

  const summaries = targets.map(target => summarizeTarget(target.name, samplesByTarget.get(target.name)!));
  const delta = buildDelta(summaries);
  return {
    case: config.name,
    workRoot: caseRoot,
    packageCount: config.packageCount,
    packageJsonBytesEach: config.packageJsonBytes,
    packageJsonBytesTotal,
    machineBytesTotal,
    generationMsExcluded,
    proof,
    targets: summaries,
    delta,
  };
}

function generateCaseFixture(caseRoot: string, config: CaseConfig): number {
  mkdirSync(join(caseRoot, "scripts"), { recursive: true });
  mkdirSync(join(caseRoot, "src"), { recursive: true });
  mkdirSync(join(caseRoot, "node_modules"), { recursive: true });
  copyFileSync(
    join(repoRoot, "scripts", "dx-js-machine-cache.ps1"),
    join(caseRoot, "scripts", "dx-js-machine-cache.ps1"),
  );
  copyFileSync(
    join(repoRoot, "scripts", "dx-serializer-evidence-lock.json"),
    join(caseRoot, "scripts", "dx-serializer-evidence-lock.json"),
  );

  writeFileSync(
    join(caseRoot, "package.json"),
    JSON.stringify({ name: `dx-local-machine-${config.name}`, private: true, type: "module" }, null, 2) + "\n",
  );
  writeFileSync(join(caseRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext" } }) + "\n");
  writeFileSync(
    join(caseRoot, "bench-worker.ts"),
    [
      "const expected = Number(process.env.DX_EXPECTED_SUM);",
      "const started = performance.now();",
      'const loaded = await import("./src/entry.ts");',
      "const ms = performance.now() - started;",
      "if (loaded.sum !== expected) {",
      "  console.error(`sum mismatch: expected ${expected}, got ${loaded.sum}`);",
      "  process.exit(1);",
      "}",
      "console.log(JSON.stringify({ ms, sum: loaded.sum }));",
      "",
    ].join("\n"),
  );

  const imports: string[] = [];
  const sumTerms: string[] = [];
  let packageJsonBytesTotal = 0;
  for (let index = 0; index < config.packageCount; index++) {
    const packageName = packageFixtureName(config.name, index);
    const binding = `value${index}`;
    imports.push(`import { value as ${binding} } from "${packageName}";`);
    sumTerms.push(binding);

    const packageRoot = join(caseRoot, "node_modules", packageName);
    mkdirSync(packageRoot, { recursive: true });
    const packageJson = packageJsonText(packageName, index, config.packageJsonBytes);
    packageJsonBytesTotal += Buffer.byteLength(packageJson);
    writeFileSync(join(packageRoot, "package.json"), packageJson);
    writeFileSync(join(packageRoot, "index.ts"), `export const value = 1;\n`);
  }

  writeFileSync(
    join(caseRoot, "src", "entry.ts"),
    `${imports.join("\n")}\n\nexport const sum = ${sumTerms.join(" + ")};\n`,
  );
  return packageJsonBytesTotal;
}

function packageJsonText(packageName: string, index: number, targetBytes: number): string {
  const value: Record<string, unknown> = {
    name: packageName,
    version: "1.0.0",
    type: "module",
    main: "./index.ts",
    module: "./index.ts",
    exports: {
      ".": "./index.ts",
    },
    sideEffects: false,
    dxIgnoredMetadata: {},
  };
  const ignored = value.dxIgnoredMetadata as Record<string, string>;
  let fieldIndex = 0;
  while (Buffer.byteLength(JSON.stringify(value) + "\n") < targetBytes) {
    const remaining = targetBytes - Buffer.byteLength(JSON.stringify(value) + "\n");
    const chunkLength = Math.max(16, Math.min(512, remaining - 48));
    ignored[`field${String(fieldIndex).padStart(4, "0")}`] = `${packageName}:${index}:${fieldIndex}:`.padEnd(
      chunkLength,
      "x",
    );
    fieldIndex++;
  }
  return JSON.stringify(value) + "\n";
}

function generateMachineCache(caseRoot: string, config: CaseConfig): void {
  const inputs = [
    "package.json",
    "tsconfig.json",
    ...Array.from(
      { length: config.packageCount },
      (_, index) => `node_modules/${packageFixtureName(config.name, index)}/package.json`,
    ),
  ];
  const inputsPath = join(caseRoot, ".dx-machine-cache-inputs.json");
  writeFileSync(inputsPath, JSON.stringify(inputs, null, 2) + "\n");
  const command = [
    `$inputs = Get-Content -LiteralPath ${quotePowerShellSingle(inputsPath)} -Raw | ConvertFrom-Json;`,
    "&",
    quotePowerShellSingle(join(caseRoot, "scripts", "dx-js-machine-cache.ps1")),
    "-SerializerManifest",
    quotePowerShellSingle(serializerManifest),
    "-Inputs",
    "$inputs",
    "-NoWorkspacePackages",
    "-NoCompression",
    "-MaxParallelSerializers",
    "1",
  ].join(" ");
  runCommand("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], caseRoot, {
    DX_SERIALIZER_MANIFEST: serializerManifest,
  });
  if (!existsSync(join(caseRoot, ".dx", "js", "catalog.machine"))) {
    throw new Error(`DX serializer did not generate a catalog for ${config.name}`);
  }
}

function runProof(caseRoot: string, config: CaseConfig, target: TargetConfig): ProofSummary {
  const proofLog = join(caseRoot, `.dx-proof-${target.name}.jsonl`);
  rmSync(proofLog, { force: true });
  runWorker(caseRoot, config, target, -1, [target.name], {
    BUN_DX_MACHINE_CACHE_PROOF_LOG: proofLog,
  });
  const events = existsSync(proofLog)
    ? readFileSync(proofLog, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as { event: string; sourcePath: string })
        .filter(event => isFixturePackagePath(config.name, event.sourcePath))
    : [];
  const eventPaths = (eventName: string) =>
    new Set(events.filter(event => event.event === eventName).map(event => event.sourcePath));
  const parseAttempts = eventPaths("parse_attempt").size;
  const normalFileReads = eventPaths("normal_file_read").size;
  const machineHitPathRef = eventPaths("machine_hit_path_ref").size;
  const machineHitPathOwned = eventPaths("machine_hit_path_owned").size;
  const pathRefReads = eventPaths("path_ref_read_some").size;
  const pathOwnedReads = eventPaths("path_owned_read_some").size;
  const packedPayloadHits = eventPaths("packed_package_json_payload_hit").size;
  const sourceValidationReads = eventPaths("source_validation_read").size;
  const machineHits = machineHitPathRef + machineHitPathOwned;
  const packagePathsSeen = new Set(events.map(event => event.sourcePath)).size;

  if (target.name === "local-json") {
    assertProofCount(target.name, "normal file reads", normalFileReads, config.packageCount);
    assertProofCount(target.name, "machine hits", machineHits, 0);
  } else {
    assertProofCount(target.name, "machine hits", machineHits, config.packageCount);
    assertProofCount(target.name, "path ref reads", pathRefReads, config.packageCount);
    assertProofCount(target.name, "normal file reads", normalFileReads, 0);
    assertProofCount(target.name, "source validation reads", sourceValidationReads, 0);
  }

  return {
    target: target.name,
    packagePathsSeen,
    parseAttempts,
    normalFileReads,
    machineHits,
    pathRefReads,
    pathOwnedReads,
    packedPayloadHits,
    sourceValidationReads,
  };
}

function runWorker(
  caseRoot: string,
  config: CaseConfig,
  target: TargetConfig,
  roundIndex: number,
  targetOrder: TargetName[],
  extraEnv: NodeJS.ProcessEnv = {},
): Sample {
  const result = runCommandText(localBunPath, ["run", "./bench-worker.ts"], caseRoot, {
    ...target.env,
    ...(target.name === "local-machine" ? { BUN_DX_MACHINE_CACHE_ROOT: caseRoot } : {}),
    ...extraEnv,
    DX_EXPECTED_SUM: String(config.packageCount),
  });
  assertNoMachineCacheWarning(target.name, result.stderr, caseRoot);
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!line) {
    throw new Error(`${target.name} produced no benchmark output`);
  }
  const parsed = JSON.parse(line) as { ms: number; sum: number };
  if (parsed.sum !== config.packageCount) {
    throw new Error(`${target.name} sum mismatch: expected ${config.packageCount}, got ${parsed.sum}`);
  }
  return { ms: parsed.ms, roundIndex, targetOrder };
}

function summarizeTarget(target: TargetName, samples: Sample[]): TargetSummary {
  const values = samples.map(sample => sample.ms).sort((a, b) => a - b);
  const trim = Math.floor(values.length * trimRatio);
  const trimmed = values.slice(trim, values.length - trim || values.length);
  const meanMs = mean(values);
  const medianMs = percentile(values, 0.5);
  const iqrMs = percentile(values, 0.75) - percentile(values, 0.25);
  const cvPct = meanMs === 0 ? 0 : (standardDeviation(values, meanMs) / meanMs) * 100;
  return {
    target,
    trimmedMeanMs: round(mean(trimmed)),
    medianMs: round(medianMs),
    iqrMs: round(iqrMs),
    cvPct: round(cvPct),
    minMs: round(values[0]),
    maxMs: round(values[values.length - 1]),
    runs: values.length,
    warmups,
    signal: classifySamples(values.length, cvPct, iqrMs, medianMs),
    samplesMs: values.map(round),
  };
}

function buildDelta(summaries: TargetSummary[]): CaseResult["delta"] {
  const baseline = summaries.find(summary => summary.target === "local-json");
  const candidate = summaries.find(summary => summary.target === "local-machine");
  if (!baseline || !candidate) {
    throw new Error("Missing local-json or local-machine summary");
  }
  const candidateVsBaselinePct = round(
    ((baseline.trimmedMeanMs - candidate.trimmedMeanMs) / baseline.trimmedMeanMs) * 100,
  );
  const speedup = round(baseline.trimmedMeanMs / candidate.trimmedMeanMs);
  const hasSignal = baseline.signal === "signal" && candidate.signal === "signal";
  const rankable = hasSignal && Math.abs(candidateVsBaselinePct) >= minMeaningfulEffectPct;
  return {
    baseline: "local-json",
    candidate: "local-machine",
    candidateVsBaselinePct,
    speedup,
    rankable,
    faster: rankable
      ? candidate.trimmedMeanMs < baseline.trimmedMeanMs
        ? "local-machine"
        : "local-json"
      : hasSignal
        ? "inconclusive"
        : "unranked",
  };
}

function orderedTargetsForSample(sampleIndex: number): TargetConfig[] {
  const offset = sampleIndex % targets.length;
  return [...targets.slice(offset), ...targets.slice(0, offset)];
}

function orderedTargetNames(sampleIndex: number): TargetName[] {
  return orderedTargetsForSample(sampleIndex).map(target => target.name);
}

function inspectLocalBun(path: string) {
  const file = statSync(path);
  return {
    path,
    revision: runCommandText(path, ["--revision"], repoRoot, {}).stdout.trim(),
    version: runCommandText(path, ["--version"], repoRoot, {}).stdout.trim(),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    sizeBytes: file.size,
  };
}

function inspectRepoProof(localPath: string) {
  const gitHead = runGitText(["rev-parse", "HEAD"]).trim().toLowerCase();
  const gitStatus = runGitText(["status", "--porcelain=v1", "--untracked-files=no"])
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean);
  const releaseProofCommit = releaseProofCommitFromPath(localPath);
  const releaseProofCommitMatchesHead = releaseProofCommit ? gitHead.startsWith(releaseProofCommit) : null;
  return {
    gitHead,
    gitHeadShort: gitHead.slice(0, 12),
    gitDirty: gitStatus.length > 0,
    gitStatus,
    releaseProofCommit,
    releaseProofCommitMatchesHead,
    localProofMatchesHead: releaseProofCommit ? releaseProofCommitMatchesHead === true && gitStatus.length === 0 : null,
    staleProofWaived: process.env.DX_LOCAL_MACHINE_BENCH_ALLOW_STALE_LOCAL_PROOF === "1",
  };
}

function assertLocalProofFresh(proof: ReturnType<typeof inspectRepoProof>): void {
  if (proof.localProofMatchesHead === true || proof.staleProofWaived) {
    return;
  }
  throw new Error(
    [
      "Local release-proof Bun does not match the current clean Git HEAD.",
      `gitHead=${proof.gitHeadShort}`,
      `gitDirty=${proof.gitDirty}`,
      `releaseProofCommit=${proof.releaseProofCommit ?? "missing"}`,
      "Build a fresh release-proof Bun or set DX_LOCAL_MACHINE_BENCH_ALLOW_STALE_LOCAL_PROOF=1 for a smoke-only run.",
    ].join("\n"),
  );
}

function resolveLocalBun(): string {
  const envPath = process.env.DX_LOCAL_BUN;
  if (envPath && envPath.trim()) {
    return envPath;
  }
  const latest = latestReleaseProofBun();
  if (latest) {
    return latest;
  }
  throw new Error("DX_LOCAL_BUN or a build/release-proof-* bun.exe is required for local-only benchmarking");
}

function latestReleaseProofBun(): string | undefined {
  const buildRoot = join(repoRoot, "build");
  if (!existsSync(buildRoot)) {
    return undefined;
  }
  let latest: { path: string; mtimeMs: number } | undefined;
  for (const entry of readdirSync(buildRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("release-proof-")) {
      continue;
    }
    const bunPath = join(buildRoot, entry.name, "bun.exe");
    if (!existsSync(bunPath)) {
      continue;
    }
    const mtimeMs = statSync(bunPath).mtimeMs;
    if (!latest || mtimeMs > latest.mtimeMs) {
      latest = { path: bunPath, mtimeMs };
    }
  }
  return latest?.path;
}

function releaseProofCommitFromPath(bunPath: string): string | null {
  const match = /^release-proof-([0-9a-f]{7,40})(?:-|$)/i.exec(basename(dirname(bunPath)));
  return match ? match[1].toLowerCase() : null;
}

function assertLocalBunAllowed(path: string): void {
  const normalized = normalize(path).toLowerCase();
  const disallowed = normalize("G:\\Dev\\Tools\\Bun\\bin\\bun.exe").toLowerCase();
  if (normalized === disallowed) {
    throw new Error("Benchmark target must be the local Bun fork release-proof binary, not the installed tools Bun");
  }
}

function assertNoMachineCacheWarning(target: TargetName, stderr: string, caseRoot: string): void {
  const normalizedCaseRoot = caseRoot.replaceAll("\\", "/");
  const warning = stderr.split(/\r?\n/).find(line => {
    const normalizedLine = line.replaceAll("\\", "/");
    return (
      normalizedLine.includes(normalizedCaseRoot) &&
      (normalizedLine.includes("[dx-machine-cache] read-through failed") ||
        normalizedLine.includes("[dx-machine-cache] shadow validation failed"))
    );
  });
  if (warning) {
    throw new Error(`${target} emitted a fixture machine-cache warning:\n${warning}`);
  }
}

function assertProofCount(target: TargetName, label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`${target} proof mismatch for ${label}: expected ${expected}, got ${actual}`);
  }
}

function isFixturePackagePath(caseName: CaseName, value: string): boolean {
  const normalizedPath = value.replaceAll("\\", "/");
  const packageSegment = `node_modules/${packageFixturePrefix(caseName)}`;
  return (
    (normalizedPath.includes(`/${packageSegment}`) || normalizedPath.startsWith(packageSegment)) &&
    normalizedPath.endsWith("/package.json")
  );
}

function packageFixtureName(caseName: CaseName, index: number): string {
  return `${packageFixturePrefix(caseName)}${String(index).padStart(4, "0")}`;
}

function packageFixturePrefix(caseName: CaseName): string {
  return `dx-local-machine-${caseName}-`;
}

function sumGeneratedMachineBytes(caseRoot: string): number {
  return walkFiles(join(caseRoot, ".dx", "js"))
    .filter(path => path.endsWith(".machine"))
    .reduce((sum, path) => sum + statSync(path).size, 0);
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function renderMarkdown(result: BenchmarkResult): string {
  const lines = [
    "# DX Local JSON vs Machine Benchmark",
    "",
    `Generated: ${result.generatedAtUtc}`,
    `Git HEAD: ${result.repoProof.gitHeadShort}`,
    `Git dirty: ${result.repoProof.gitDirty}`,
    `Local Bun: ${result.localBun.path}`,
    `Revision: ${result.localBun.revision}`,
    `Generation excluded from timing: ${result.generationExcludedFromTiming}`,
    `Process startup excluded from timing: ${result.processStartupExcludedFromTiming}`,
    `Worker extension: .${result.workerExtension}`,
    `Runs/warmups: ${result.runs}/${result.warmups}`,
    "",
    "| case | JSON bytes | machine bytes | local JSON | local DX machine | delta | speedup | signal |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const item of result.cases) {
    const json = item.targets.find(target => target.target === "local-json")!;
    const machine = item.targets.find(target => target.target === "local-machine")!;
    lines.push(
      `| ${item.case} | ${item.packageJsonBytesTotal} | ${item.machineBytesTotal} | ${json.trimmedMeanMs}ms | ${machine.trimmedMeanMs}ms | ${item.delta.candidateVsBaselinePct}% | ${item.delta.speedup}x | ${json.signal}/${machine.signal} |`,
    );
  }
  lines.push("", "| case | proof | decision |", "| --- | --- | --- |");
  for (const item of result.cases) {
    const machineProof = item.proof.find(proof => proof.target === "local-machine")!;
    const decision = item.delta.rankable ? `${item.delta.faster} rankable` : item.delta.faster;
    lines.push(
      `| ${item.case} | machine hits ${machineProof.machineHits}/${item.packageCount}, normal reads ${machineProof.normalFileReads}, source validation reads ${machineProof.sourceValidationReads} | ${decision} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function resetWorkRoot(): void {
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
}

function runGitText(args: string[]): string {
  return runCommandText("git", args, repoRoot, {}).stdout;
}

function runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  runCommandText(command, args, cwd, env);
}

function runCommandText(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...benchmarkBaseProcessEnv, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 180000,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `status=${result.status} signal=${result.signal ?? ""}`,
        `stdout=${result.stdout}`,
        `stderr=${result.stderr}`,
      ].join("\n"),
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function sanitizedBenchmarkEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase().startsWith("BUN_")) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

function selectedCaseSetEnv(name: string): Set<CaseName> | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const cases = raw
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
  const allowed = new Set(["small", "medium", "large"]);
  for (const value of cases) {
    if (!allowed.has(value)) {
      throw new Error(`${name} contains unknown case ${value}`);
    }
  }
  return new Set(cases as CaseName[]);
}

function assertInsideRepoTmp(target: string): void {
  const normalizedRepoTmp = join(repoRoot, ".tmp");
  if (!target.startsWith(normalizedRepoTmp)) {
    throw new Error(`Refusing to reset non-.tmp benchmark directory: ${target}`);
  }
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function classifySamples(runs: number, cvPct: number, iqrMs: number, medianMs: number): BenchmarkSignal {
  if (runs < minRankableRuns) {
    return "underpowered";
  }
  if (cvPct > maxRankableCvPct) {
    return "noisy";
  }
  if (medianMs > 0 && iqrMs / medianMs > maxRankableIqrMedianRatio) {
    return "noisy";
  }
  return "signal";
}

function percentile(sortedValues: number[], point: number): number {
  const index = (sortedValues.length - 1) * point;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], meanMs: number): number {
  return Math.sqrt(values.reduce((sum, value) => sum + (value - meanMs) ** 2, 0) / values.length);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function safeSnapshotPart(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9+._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80);
}
