import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDeltas,
  type BenchmarkDelta,
  type BenchmarkSignal,
} from "./dx-machine-cache-runtime-benchmark-deltas.ts";

type Target = {
  name: string;
  bun: string;
  pathSource: string;
  env?: NodeJS.ProcessEnv;
  expectsMachineCacheRead?: boolean;
};

type Sample = {
  ms: number;
  output: string;
  roundIndex: number;
  targetOrder: string[];
};

type CommandText = {
  stdout: string;
  stderr: string;
};

type TargetSummary = {
  target: string;
  path: string;
  pathSource: string;
  revision: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  envOverrides: Record<string, string>;
  meanMs: number;
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
  rawSamples: Array<{
    roundIndex: number;
    targetOrder: string[];
    ms: number;
  }>;
};

type BenchmarkResult = {
  schema: "dx.machine_cache_runtime_benchmark.v1";
  generatedAtUtc: string;
  repoProof: ReturnType<typeof inspectRepoProof>;
  fixture: {
    workRoot: string;
    packageCount: number;
    moduleExtension: ModuleExtension;
    entryFile: string;
    runs: number;
    warmups: number;
    machineCache: ReturnType<typeof inspectMachineCache>;
    generationExcludedFromTiming: true;
    measurementOrder: "alternating-targets";
    timedCommand: string;
    commandLine: string;
    benchEnv: Record<string, string>;
    localFeatureEnv: string;
    currentLimit: string;
  };
  targets: TargetSummary[];
  deltas: BenchmarkDelta[];
};

type TargetMetadata = Pick<
  TargetSummary,
  "target" | "path" | "pathSource" | "revision" | "version" | "sha256" | "sizeBytes"
>;
type SampleSummary = Omit<
  TargetSummary,
  "target" | "path" | "pathSource" | "revision" | "version" | "sha256" | "sizeBytes" | "envOverrides"
>;
type ModuleExtension = "ts" | "js";

const minRankableRuns = 20;
const maxRankableCvPct = 35;
const maxRankableIqrMedianRatio = 0.45;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = join(repoRoot, ".tmp", "dx-machine-cache-runtime-bench");
const officialBun = configuredBunPath(
  "DX_OFFICIAL_BUN",
  "G:\\Dev\\Tools\\Bun\\bin\\bun.exe",
  "default G-drive official Bun",
);
const localBun = resolveLocalBun();
const serializerManifest = process.env.DX_SERIALIZER_MANIFEST || "G:\\dx\\serializer\\Cargo.toml";
const runs = positiveIntegerEnv("DX_MACHINE_CACHE_BENCH_RUNS", 30);
const warmups = positiveIntegerEnv("DX_MACHINE_CACHE_BENCH_WARMUPS", 5);
const packageCount = positiveIntegerEnv("DX_MACHINE_CACHE_BENCH_PACKAGES", 96);
const moduleExtension = moduleExtensionEnv("DX_MACHINE_CACHE_BENCH_MODULE_EXT", "ts");
const entryFile = `./src/entry.${moduleExtension}`;
const trimRatio = 0.1;
const benchmarkBaseProcessEnv = sanitizedBenchmarkEnv();
const selectedTargetNames = optionalTargetSetEnv("DX_MACHINE_CACHE_BENCH_TARGETS");
const allowStaleLocalProof = process.env.DX_MACHINE_CACHE_BENCH_ALLOW_STALE_LOCAL_PROOF === "1";
const repoProof = inspectRepoProof(localBun);

const allTargets: Target[] = [
  { name: "official-json", bun: officialBun.path, pathSource: officialBun.source },
  {
    name: "local-json",
    bun: localBun.path,
    pathSource: localBun.source,
    env: { BUN_DX_MACHINE_CACHE_DISABLE: "1" },
  },
  {
    name: "local-machine-integrated",
    bun: localBun.path,
    pathSource: localBun.source,
    expectsMachineCacheRead: true,
  },
  {
    name: "local-machine-rooted",
    bun: localBun.path,
    pathSource: localBun.source,
    env: {
      BUN_DX_MACHINE_CACHE_ROOT: workRoot,
    },
    expectsMachineCacheRead: true,
  },
  {
    name: "local-machine-trust-env",
    bun: localBun.path,
    pathSource: localBun.source,
    env: {
      BUN_DX_MACHINE_CACHE_TRUST_SOURCE_METADATA: "1",
      BUN_DX_MACHINE_CACHE_TRUST_PACKAGE_JSON_READ: "1",
    },
    expectsMachineCacheRead: true,
  },
  {
    name: "local-machine-trusted",
    bun: localBun.path,
    pathSource: localBun.source,
    env: {
      BUN_DX_MACHINE_CACHE_ROOT: workRoot,
      BUN_DX_MACHINE_CACHE_TRUST_SOURCE_METADATA: "1",
      BUN_DX_MACHINE_CACHE_TRUST_PACKAGE_JSON_READ: "1",
    },
    expectsMachineCacheRead: true,
  },
];
const targets = selectedTargetNames
  ? allTargets.filter((target) => selectedTargetNames.has(target.name))
  : allTargets;
assertSelectedTargets(targets, selectedTargetNames);
assertLocalProofFresh(repoProof);

main();

function main(): void {
  assertInsideRepoTmp(workRoot);
  resetFixture();
  generateFixture();
  generateMachineCache();

  const expectedOutput = String((packageCount * (packageCount - 1)) / 2);
  const targetMetadata = new Map<string, TargetMetadata>();
  const samplesByTarget = new Map<string, Sample[]>();

  for (const target of targets) {
    targetMetadata.set(target.name, inspectTarget(target));
    samplesByTarget.set(target.name, []);
  }

  for (let warmupIndex = 0; warmupIndex < warmups; warmupIndex++) {
    const orderedTargets = orderedTargetsForSample(warmupIndex);
    const targetOrder = orderedTargets.map((target) => target.name);
    for (const target of orderedTargets) {
      runTarget(target, expectedOutput, warmupIndex, targetOrder);
    }
  }

  for (let sampleIndex = 0; sampleIndex < runs; sampleIndex++) {
    const orderedTargets = orderedTargetsForSample(sampleIndex);
    const targetOrder = orderedTargets.map((target) => target.name);
    for (const target of orderedTargets) {
      samplesByTarget
        .get(target.name)!
        .push(runTarget(target, expectedOutput, sampleIndex, targetOrder));
    }
  }

  const summaries = targets.map((target) => ({
    ...requiredMapValue(targetMetadata, target.name),
    envOverrides: stableEnvOverrides(target.env),
    ...summarizeSamples(requiredMapValue(samplesByTarget, target.name)),
  }));

  const generatedAtUtc = new Date().toISOString();
  const result: BenchmarkResult = {
    schema: "dx.machine_cache_runtime_benchmark.v1",
    generatedAtUtc,
    repoProof,
    fixture: {
      workRoot,
      packageCount,
      moduleExtension,
      entryFile,
      runs,
      warmups,
      machineCache: inspectMachineCache(),
      generationExcludedFromTiming: true,
      measurementOrder: "alternating-targets",
      timedCommand: `bun run ${entryFile}`,
      commandLine: [process.execPath, ...process.argv.slice(1)].join(" "),
      benchEnv: stableBenchmarkEnv(),
      localFeatureEnv:
        "local-json uses BUN_DX_MACHINE_CACHE_DISABLE=1; local-machine-integrated uses no BUN_DX_MACHINE_CACHE_* override; local-machine-rooted sets only BUN_DX_MACHINE_CACHE_ROOT; local-machine-trust-env sets only the trust flags; ambient BUN_* env is stripped by sanitizedBenchmarkEnv()",
      currentLimit:
        "local-machine-integrated is the default DX package-json machine read path when a valid .dx/js/catalog.machine exists. It validates source bytes by hash, reads identity-bound packed v5 package-json resolver payloads, borrows archived resolver strings from the process-cached shard mmap, keeps the root exports/imports value machine-backed at load time, materializes resolver maps only as needed, and falls back to the normal parser on miss/failure.",
    },
    targets: summaries,
    deltas: buildDeltas(summaries),
  };

  const resultPath = join(repoRoot, ".tmp", "dx-machine-cache-runtime-benchmark-results.json");
  const summaryPath = join(repoRoot, ".tmp", "dx-machine-cache-runtime-benchmark-summary.md");
  const snapshotRoot = join(repoRoot, ".tmp", "dx-machine-cache-runtime-benchmark-snapshots");
  mkdirSync(snapshotRoot, { recursive: true });
  const snapshotSlug = benchmarkSnapshotSlug(result);
  const snapshotResultsPath = join(snapshotRoot, `results-${snapshotSlug}.json`);
  const snapshotSummaryPath = join(snapshotRoot, `summary-${snapshotSlug}.md`);
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
  writeFileSync(summaryPath, renderMarkdown(result));
  writeFileSync(snapshotResultsPath, JSON.stringify(result, null, 2) + "\n");
  writeFileSync(snapshotSummaryPath, renderMarkdown(result));

  console.log(JSON.stringify(result, null, 2));
  console.error(`[dx-machine-bench] results: ${resultPath}`);
  console.error(`[dx-machine-bench] summary: ${summaryPath}`);
  console.error(`[dx-machine-bench] snapshot results: ${snapshotResultsPath}`);
  console.error(`[dx-machine-bench] snapshot summary: ${snapshotSummaryPath}`);
}

function resetFixture(): void {
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(join(workRoot, "scripts"), { recursive: true });
  copyFileSync(
    join(repoRoot, "scripts", "dx-js-machine-cache.ps1"),
    join(workRoot, "scripts", "dx-js-machine-cache.ps1"),
  );
  copyFileSync(
    join(repoRoot, "scripts", "dx-serializer-evidence-lock.json"),
    join(workRoot, "scripts", "dx-serializer-evidence-lock.json"),
  );
}

function generateFixture(): void {
  writeFileSync(
    join(workRoot, "package.json"),
    JSON.stringify(
      {
        name: "dx-machine-runtime-bench",
        private: true,
        type: "module",
        scripts: {
          bench: `bun run ${entryFile}`,
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(workRoot, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "#bench/*": ["src/*"],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  mkdirSync(join(workRoot, "src"), { recursive: true });

  const imports: string[] = [];
  const sumTerms: string[] = [];
  for (let i = 0; i < packageCount; i++) {
    const packageName = packageFixtureName(i);
    const binding = `value${i}`;
    imports.push(`import { value as ${binding} } from "${packageName}";`);
    sumTerms.push(binding);
    writePackageFixture(packageName, i);
  }

  writeFileSync(
    join(workRoot, "src", `entry.${moduleExtension}`),
    `${imports.join("\n")}\n\nconsole.log(String(${sumTerms.join(" + ")}));\n`,
  );
}

function writePackageFixture(packageName: string, value: number): void {
  const packageRoot = join(workRoot, "node_modules", packageName);
  mkdirSync(packageRoot, { recursive: true });
  const packageJson: Record<string, unknown> = {
    name: packageName,
    version: "1.0.0",
    type: "module",
    main: `./index.${moduleExtension}`,
    module: `./index.${moduleExtension}`,
    "jsnext:main": `./index.${moduleExtension}`,
    browser: {
      [`./index.${moduleExtension}`]: `./browser.${moduleExtension}`,
      [`./feature.${moduleExtension}`]: false,
    },
    sideEffects: value % 2 === 0 ? false : [`./feature.${moduleExtension}`],
  };
  if (value % 2 === 0) {
    packageJson.exports = {
      ".": `./index.${moduleExtension}`,
      "./feature": `./feature.${moduleExtension}`,
    };
  }
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify(packageJson, null, 2) + "\n",
  );
  writeFileSync(join(packageRoot, `index.${moduleExtension}`), `export const value = ${value};\n`);
  writeFileSync(join(packageRoot, `feature.${moduleExtension}`), `export const feature = "pkg-${value}";\n`);
  writeFileSync(join(packageRoot, `browser.${moduleExtension}`), `export const value = ${value};\n`);
}

function generateMachineCache(): void {
  const script = join(workRoot, "scripts", "dx-js-machine-cache.ps1");
  const inputs = [
    "package.json",
    "tsconfig.json",
    ...Array.from({ length: packageCount }, (_, index) =>
      `node_modules/${packageFixtureName(index)}/package.json`,
    ),
  ];
  const inputsPath = join(workRoot, ".dx-machine-cache-inputs.json");
  writeFileSync(inputsPath, JSON.stringify(inputs, null, 2) + "\n");
  const command = [
    `$inputs = Get-Content -LiteralPath ${quotePowerShellSingle(inputsPath)} -Raw | ConvertFrom-Json;`,
    "&",
    quotePowerShellSingle(script),
    "-SerializerManifest",
    quotePowerShellSingle(serializerManifest),
    "-Inputs",
    "$inputs",
    "-NoWorkspacePackages",
    "-NoCompression",
    "-MaxParallelSerializers",
    "1",
  ].join(" ");
  runOrThrow(
    "pwsh",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    workRoot,
    {
      DX_SERIALIZER_MANIFEST: serializerManifest,
    },
  );

  const catalogMachine = join(workRoot, ".dx", "js", "catalog.machine");
  if (!existsSync(catalogMachine)) {
    throw new Error(`DX serializer did not generate ${catalogMachine}`);
  }
}

function configuredBunPath(envName: string, fallback: string, fallbackSource: string) {
  const envValue = process.env[envName];
  return {
    path: envValue && envValue.trim() ? envValue : fallback,
    source: envValue && envValue.trim() ? envName : fallbackSource,
  };
}

function resolveLocalBun() {
  const envValue = process.env.DX_LOCAL_BUN;
  if (envValue && envValue.trim()) {
    return { path: envValue, source: "DX_LOCAL_BUN" };
  }

  const latestProof = latestReleaseProofBun();
  if (latestProof) {
    return { path: latestProof, source: "latest build/release-proof-* bun.exe" };
  }

  const releaseBun = join(repoRoot, "build", "release", "bun.exe");
  if (existsSync(releaseBun)) {
    return { path: releaseBun, source: "build/release/bun.exe fallback" };
  }

  throw new Error(
    "DX_LOCAL_BUN is required because no build/release-proof-* or build/release/bun.exe local Bun was found",
  );
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

function inspectRepoProof(local: { path: string; source: string }) {
  const gitHead = runGitText(["rev-parse", "HEAD"]).trim().toLowerCase();
  const gitStatus = runGitText(["status", "--porcelain=v1", "--untracked-files=no"])
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const releaseProofCommit = releaseProofCommitFromPath(local.path);
  const releaseProofCommitMatchesHead = releaseProofCommit
    ? gitHead.startsWith(releaseProofCommit)
    : null;

  return {
    gitHead,
    gitHeadShort: gitHead.slice(0, 12),
    gitDirty: gitStatus.length > 0,
    gitStatus,
    localBunPath: local.path,
    localBunPathSource: local.source,
    releaseProofCommit,
    releaseProofCommitMatchesHead,
    localProofMatchesHead: releaseProofCommit
      ? releaseProofCommitMatchesHead === true && gitStatus.length === 0
      : null,
    staleProofWaived: allowStaleLocalProof,
  };
}

function assertLocalProofFresh(proof: ReturnType<typeof inspectRepoProof>): void {
  if (proof.releaseProofCommit === null || proof.localProofMatchesHead === true || proof.staleProofWaived) {
    return;
  }

  throw new Error(
    [
      "Local release-proof Bun does not match the current clean Git HEAD.",
      `gitHead=${proof.gitHeadShort}`,
      `gitDirty=${proof.gitDirty}`,
      `releaseProofCommit=${proof.releaseProofCommit}`,
      `localBunPath=${proof.localBunPath}`,
      "Set DX_MACHINE_CACHE_BENCH_ALLOW_STALE_LOCAL_PROOF=1 only when intentionally recording stale-binary evidence.",
    ].join("\n"),
  );
}

function releaseProofCommitFromPath(bunPath: string): string | null {
  const parent = basename(dirname(bunPath));
  const match = /^release-proof-([0-9a-f]{7,40})(?:-|$)/i.exec(parent);
  return match ? match[1].toLowerCase() : null;
}

function runGitText(args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: git ${args.join(" ")}`,
        `status=${result.status} signal=${result.signal ?? ""}`,
        `stdout=${result.stdout}`,
        `stderr=${result.stderr}`,
      ].join("\n"),
    );
  }

  return result.stdout;
}

function inspectTarget(target: Target): TargetMetadata {
  const file = statSync(target.bun);
  return {
    target: target.name,
    path: target.bun,
    pathSource: target.pathSource,
    revision: runText(target.bun, ["--revision"], workRoot, target.env).trim(),
    version: runText(target.bun, ["--version"], workRoot, target.env).trim(),
    sha256: sha256File(target.bun),
    sizeBytes: file.size,
  };
}

function orderedTargetsForSample(sampleIndex: number): Target[] {
  const offset = sampleIndex % targets.length;
  return [...targets.slice(offset), ...targets.slice(0, offset)];
}

function runTarget(
  target: Target,
  expectedOutput: string,
  roundIndex: number,
  targetOrder: string[],
): Sample {
  const started = performance.now();
  const result = runCommandText(target.bun, ["run", entryFile], workRoot, target.env);
  assertNoMachineCacheWarning(target, result.stderr);
  const output = result.stdout.trim();
  const ms = performance.now() - started;
  if (output !== expectedOutput) {
    throw new Error(`${target.name} output mismatch: expected ${expectedOutput}, got ${output}`);
  }
  return { ms, output, roundIndex, targetOrder };
}

function assertNoMachineCacheWarning(target: Target, stderr: string): void {
  if (!targetUsesMachineCache(target)) {
    return;
  }

  const warning = [
    "[dx-machine-cache] read-through failed",
    "[dx-machine-cache] shadow validation failed",
  ].find((marker) => stderr.includes(marker));
  if (warning) {
    throw new Error(`${target.name} emitted ${warning}:\n${stderr}`);
  }
}

function targetUsesMachineCache(target: Target): boolean {
  return target.expectsMachineCacheRead === true;
}

function runText(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): string {
  return runCommandText(command, args, cwd, env).stdout;
}

function runCommandText(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): CommandText {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...benchmarkBaseProcessEnv, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
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

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runOrThrow(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined = undefined,
): void {
  runText(command, args, cwd, env);
}

function requiredMapValue<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Missing benchmark value for ${String(key)}`);
  }
  return value;
}

function packageFixtureName(index: number): string {
  return `dx-machine-pkg-${String(index).padStart(3, "0")}`;
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function summarizeSamples(samples: Sample[]): SampleSummary {
  const values = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const trim = Math.floor(values.length * trimRatio);
  const trimmed = values.slice(trim, values.length - trim || values.length);
  const meanMs = round(mean(values));
  const medianMs = round(percentile(values, 0.5));
  const iqrMs = round(percentile(values, 0.75) - percentile(values, 0.25));
  const standardDeviationMs = standardDeviation(values, meanMs);
  const cvPct = round(meanMs === 0 ? 0 : (standardDeviationMs / meanMs) * 100);
  return {
    meanMs,
    trimmedMeanMs: round(mean(trimmed)),
    medianMs,
    iqrMs,
    cvPct,
    minMs: round(values[0]),
    maxMs: round(values[values.length - 1]),
    runs: values.length,
    warmups,
    signal: classifySamples(values.length, cvPct, iqrMs, medianMs),
    samplesMs: values.map(round),
    rawSamples: samples.map((sample) => ({
      roundIndex: sample.roundIndex,
      targetOrder: sample.targetOrder,
      ms: round(sample.ms),
    })),
  };
}

function inspectMachineCache() {
  const machineRoot = join(workRoot, ".dx", "js");
  const machineFiles = readdirSync(machineRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".machine"))
    .length;
  const shardRoot = join(machineRoot, "shards");
  const shardFiles = existsSync(shardRoot)
    ? readdirSync(shardRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length
    : 0;

  return {
    catalogMachine: existsSync(join(machineRoot, "catalog.machine")),
    machineFiles,
    shardFiles,
    catalogMachineBytes: statSync(join(machineRoot, "catalog.machine")).size,
  };
}

function renderMarkdown(result: BenchmarkResult): string {
  const lines = [
    `# DX Machine Cache Runtime Benchmark`,
    ``,
    `Generated: ${result.generatedAtUtc}`,
    ``,
    `Git HEAD: ${result.repoProof.gitHeadShort}`,
    `Git dirty: ${result.repoProof.gitDirty}`,
    `Local Bun path source: ${result.repoProof.localBunPathSource}`,
    `Release-proof commit: ${result.repoProof.releaseProofCommit ?? "not release-proof-tagged"}`,
    `Release-proof commit matches HEAD: ${result.repoProof.releaseProofCommitMatchesHead ?? "n/a"}`,
    `Local proof matches clean HEAD: ${result.repoProof.localProofMatchesHead ?? "n/a"}`,
    `Stale proof waived: ${result.repoProof.staleProofWaived}`,
    ``,
    `Generation excluded from timing: ${result.fixture.generationExcludedFromTiming}`,
    `Measurement order: ${result.fixture.measurementOrder}`,
    `Fixture packages: ${result.fixture.packageCount}`,
    `Module extension: ${result.fixture.moduleExtension}`,
    `Entry file: ${result.fixture.entryFile}`,
    `Runs/warmups: ${result.fixture.runs}/${result.fixture.warmups}`,
    `Machine files: ${result.fixture.machineCache.machineFiles}`,
    `Shard files: ${result.fixture.machineCache.shardFiles}`,
    `Command line: ${result.fixture.commandLine}`,
    `Bench env: ${JSON.stringify(result.fixture.benchEnv)}`,
    `Current limit: ${result.fixture.currentLimit}`,
    ``,
    `| target | path source | revision | signal | trimmed mean ms | median ms | iqr ms | cv % | min/max ms |`,
    `| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |`,
  ];

  for (const target of result.targets) {
    lines.push(
      `| ${target.target} | ${target.pathSource} | ${target.revision} | ${target.signal} | ${target.trimmedMeanMs} | ${target.medianMs} | ${target.iqrMs} | ${target.cvPct} | ${target.minMs}/${target.maxMs} |`,
    );
  }

  lines.push(
    ``,
    `| comparison | candidate vs baseline | min effect % | rankable | faster |`,
    `| --- | ---: | ---: | --- | --- |`,
  );
  for (const delta of result.deltas) {
    lines.push(
      `| ${delta.candidate} vs ${delta.baseline} | ${delta.candidateVsBaselinePct}% | ${delta.minMeaningfulEffectPct} | ${delta.rankable} | ${delta.faster} |`,
    );
  }
  lines.push(``);

  return lines.join("\n");
}

function benchmarkSnapshotSlug(result: BenchmarkResult): string {
  const timestamp = safeSnapshotPart(result.generatedAtUtc.replaceAll(/[-:.]/g, ""));
  const targetParts = result.targets.map((target) =>
    safeSnapshotPart(`${target.target}-${target.revision}`),
  );
  return [timestamp, ...targetParts].join("-").slice(0, 240);
}

function safeSnapshotPart(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9+._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80);
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], meanMs: number): number {
  const variance = values.reduce((sum, value) => sum + (value - meanMs) ** 2, 0) / values.length;
  return Math.sqrt(variance);
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

function stableEnvOverrides(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const stable: Record<string, string> = {};
  if (!env) {
    return stable;
  }
  for (const [key, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right))) {
    if (value !== undefined) {
      stable[key] = value;
    }
  }
  return stable;
}

function stableBenchmarkEnv(): Record<string, string> {
  const stable: Record<string, string> = {};
  for (const key of [
    "DX_OFFICIAL_BUN",
    "DX_LOCAL_BUN",
    "DX_SERIALIZER_MANIFEST",
    "DX_MACHINE_CACHE_BENCH_RUNS",
    "DX_MACHINE_CACHE_BENCH_WARMUPS",
    "DX_MACHINE_CACHE_BENCH_PACKAGES",
    "DX_MACHINE_CACHE_BENCH_MODULE_EXT",
    "DX_MACHINE_CACHE_BENCH_TARGETS",
    "DX_MACHINE_CACHE_BENCH_ALLOW_STALE_LOCAL_PROOF",
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      stable[key] = value;
    }
  }
  return stable;
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

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
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

function moduleExtensionEnv(name: string, fallback: ModuleExtension): ModuleExtension {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  if (raw === "ts" || raw === "js") {
    return raw;
  }
  throw new Error(`${name} must be "ts" or "js", got ${raw}`);
}

function optionalTargetSetEnv(name: string): Set<string> | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const names = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(`${name} must name at least one target when set`);
  }
  return new Set(names);
}

function assertSelectedTargets(
  selectedTargets: Target[],
  selectedNames: Set<string> | undefined,
): void {
  if (!selectedNames) {
    return;
  }
  const knownNames = new Set(allTargets.map((target) => target.name));
  const unknownNames = [...selectedNames].filter((name) => !knownNames.has(name));
  if (unknownNames.length > 0) {
    throw new Error(`Unknown DX_MACHINE_CACHE_BENCH_TARGETS target(s): ${unknownNames.join(", ")}`);
  }
  if (selectedTargets.length !== selectedNames.size) {
    throw new Error("DX_MACHINE_CACHE_BENCH_TARGETS contains duplicate target names");
  }
}

function assertInsideRepoTmp(target: string): void {
  const normalizedRepoTmp = join(repoRoot, ".tmp");
  if (!target.startsWith(normalizedRepoTmp)) {
    throw new Error(`Refusing to reset non-.tmp benchmark directory: ${target}`);
  }
}
