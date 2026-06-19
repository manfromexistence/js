import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

type Fixture = {
  repo: string;
  manifest: string;
  script: string;
  bin: string;
};

type IndexEntry = {
  source: string;
  kind: string;
  stem: string;
  machine: string;
  metadata: string;
  sourceBytes: number;
  sourceModifiedUnixMs: number;
  sourceBlake3: string;
  machineBlake3: string;
  machineBytes: number;
  metadataBytes: number;
  keyInterning?: string;
};

type CacheIndex = {
  schema: string;
  generatedAtUtc: string;
  entries: IndexEntry[];
};

type CacheCatalog = {
  schema: string;
  generatedAtUtc: string;
  shards: string[];
  entries: Array<{
    key: string;
    kind: string;
    source: string;
    shard: string;
    machine: string;
    metadata: string;
    keyInterning?: string;
    sourceBytes: number;
    sourceModifiedUnixMs: number;
    sourceBlake3: string;
    machineBlake3: string;
    machineBytes: number;
    metadataBytes: number;
  }>;
};

const repoRoot = path.resolve(import.meta.dir, "..");
const testRoot = path.join(repoRoot, ".tmp", `dx-js-machine-cache-script-test-${process.pid}`);
const sourceScript = path.join(import.meta.dir, "dx-js-machine-cache.ps1");
const cargoCallLog = path.join(".dx", "fake-cargo-calls.jsonl");
const serializerCallLog = path.join(".dx", "fake-dx-serialize-calls.jsonl");
const processTestTimeout = 30000;

function mkdirp(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

function writeFile(target: string, contents: string): void {
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, contents);
}

function fakeContentHash(kind: "source" | "machine", value: string): string {
  return createHash("sha256").update(kind + "\0" + value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsCacheStemPart(value: string): string {
  let output = "";
  let previousWasDash = false;

  for (const char of value) {
    const code = char.charCodeAt(0);
    const isAlphaNumeric =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);

    if (isAlphaNumeric || char === "_") {
      output += char;
      previousWasDash = false;
    } else if (!previousWasDash) {
      output += "-";
      previousWasDash = true;
    }
  }

  output = output.replace(/^-+|-+$/g, "");
  return output.trim() ? output : "path";
}

function jsCacheStem(relativePath: string): string {
  const normalized = relativePath.replaceAll("/", "\\");
  const parts = normalized.split(/[\\/]+/).filter((part) => part && part !== ".");
  const isStructured = /\.(json|toml)$/i.test(normalized);

  if (isStructured && parts.length > 1) {
    return parts.map(jsCacheStemPart).join("-");
  }

  const fileName = path.basename(normalized);
  if (isStructured) {
    return jsCacheStemPart(fileName);
  }

  return jsCacheStemPart(fileName.replace(/\.[^.]+$/, ""));
}

function fakeMetadataHash(kind: "source" | "machine", value: string): string {
  return createHash("sha256").update(`${kind}\0${value}`).digest("hex");
}

function fakeCatalogShard(source: string, kind: string, sourceHashPrefixLength = 0): string {
  const normalizedSource = source.replaceAll("\\", "/").replace(/^\.\//, "");
  const sourceBlake3 = fakeContentHash("source", normalizedSource);
  const machineBlake3 = fakeContentHash("machine", jsCacheStem(source));
  const key = `${kind}\0${normalizedSource}`;
  const contentId = createHash("sha256")
    .update(key)
    .update("\0")
    .update(sourceBlake3)
    .update("\0")
    .update(machineBlake3)
    .update("\0")
    .digest("hex")
    .slice(0, 16);

  const sourceHashPrefix =
    sourceHashPrefixLength > 0 ? `/${sourceBlake3.slice(0, sourceHashPrefixLength)}` : "";
  return `${kind}${sourceHashPrefix}/${contentId}`;
}

function setupRepo(name: string): Fixture {
  const repo = path.join(testRoot, name);
  const scripts = path.join(repo, "scripts");
  const serializer = path.join(repo, "serializer");
  const bin = path.join(repo, "bin");

  fs.rmSync(repo, { recursive: true, force: true });
  mkdirp(scripts);
  mkdirp(serializer);
  mkdirp(bin);

  fs.copyFileSync(sourceScript, path.join(scripts, "dx-js-machine-cache.ps1"));
  const serializerManifest = "[package]\nname = \"fake-dx-serializer\"\n";
  writeFile(path.join(serializer, "Cargo.toml"), serializerManifest);
  writeFile(
    path.join(scripts, "dx-serializer-evidence-lock.json"),
    JSON.stringify(
      {
        schema: "dx.serializer.external_evidence_lock.v1",
        serializerRootHint: serializer.replaceAll("\\", "/"),
        files: [
          {
            path: "Cargo.toml",
            bytes: Buffer.byteLength(serializerManifest),
            sha256: sha256Text(serializerManifest),
            reason: "Locks the fake serializer manifest for generator tests.",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );

  writeFile(
    path.join(repo, "package.json"),
    JSON.stringify(
      {
        name: "fake-workspace",
        workspaces: ["packages/*", "recursive/**", "single-package"],
      },
      null,
      2,
    ),
  );
  writeFile(path.join(repo, "tsconfig.json"), "{}\n");
  writeFile(path.join(repo, "tsconfig.base.json"), "{}\n");
  writeFile(path.join(repo, "jsconfig.json"), "{}\n");
  writeFile(path.join(repo, "bunfig.toml"), "\n");
  writeFile(path.join(repo, "bunfig.node-test.toml"), "\n");
  writeFile(path.join(repo, "tooling.toml"), "\n");
  writeFile(path.join(repo, "packages", "pkg-a", "package.json"), "{\"name\":\"pkg-a\"}\n");
  writeFile(path.join(repo, "packages", "pkg-b", "package.json"), "{\"name\":\"pkg-b\"}\n");
  writeFile(path.join(repo, "packages", "CMakeFiles", "package.json"), "{\"name\":\"ignored\"}\n");
  writeFile(path.join(repo, "packages", "node_modules", "package.json"), "{\"name\":\"ignored\"}\n");
  writeFile(path.join(repo, "single-package", "package.json"), "{\"name\":\"single\"}\n");

  writeFile(path.join(bin, "cargo.cmd"), "@echo off\r\nbun \"%~dp0fake-cargo.ts\" %*\r\n");
  writeFile(
    path.join(bin, "fake-cargo.ts"),
    `
import * as fs from "node:fs";
import * as path from "node:path";

function appendJsonLine(relativePath: string, value: unknown): void {
  const logPath = path.join(process.cwd(), relativePath);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(value) + "\\n");
}

if (process.env.DX_FAIL_ON_CARGO === "1") {
  console.error("cargo should not have been called");
  process.exit(88);
}

const args = process.argv.slice(2);
appendJsonLine(${JSON.stringify(cargoCallLog)}, { args });

const command = args[0];
if (command === "run") {
  console.error("cargo run should not be used by the cache generator");
  process.exit(87);
}

if (command !== "build") {
  console.error("fake cargo expected build, got " + JSON.stringify(args));
  process.exit(89);
}

const manifestFlag = args.indexOf("--manifest-path");
const binFlag = args.indexOf("--bin");
if (!args.includes("--locked") || manifestFlag === -1 || binFlag === -1 || args[binFlag + 1] !== "dx-serialize") {
  console.error("fake cargo received unexpected build args " + JSON.stringify(args));
  process.exit(90);
}

const manifest = args[manifestFlag + 1];
const targetDir = path.join(path.dirname(manifest), "target", "debug");
const executable = path.join(targetDir, "dx-serialize.cmd");
const fakeSerializer = path.join(process.cwd(), "bin", "fake-dx-serialize.ts");
fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(executable, "@echo off\\r\\nbun " + JSON.stringify(fakeSerializer) + " %*\\r\\n");
console.log(JSON.stringify({
  reason: "compiler-artifact",
  target: { name: "dx-serialize" },
  executable,
}));
`,
  );
  writeFile(
    path.join(bin, "fake-dx-serialize.ts"),
    `
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

function appendJsonLine(relativePath: string, value: unknown): void {
  const logPath = path.join(process.cwd(), relativePath);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(value) + "\\n");
}

function stemPart(value: string): string {
  let output = "";
  let previousWasDash = false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isAlphaNumeric =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);
    if (isAlphaNumeric || char === "_") {
      output += char;
      previousWasDash = false;
    } else if (!previousWasDash) {
      output += "-";
      previousWasDash = true;
    }
  }
  output = output.replace(/^-+|-+$/g, "");
  return output.trim() ? output : "path";
}

function cacheStem(relativePath: string): string {
  const normalized = relativePath.replaceAll("/", "\\\\");
  const parts = normalized.split(/[\\\\/]+/).filter((part) => part && part !== ".");
  const isStructured = /\\.(json|toml)$/i.test(normalized);
  if (isStructured && parts.length > 1) return parts.map(stemPart).join("-");
  const fileName = path.basename(normalized);
  if (isStructured) return stemPart(fileName);
  return stemPart(fileName.replace(/\\.[^.]+$/, ""));
}

function fakeHash(kind: "source" | "machine", value: string): string {
  return createHash("sha256").update(kind + "\\0" + value).digest("hex");
}

function saltedFakeHash(kind: "source" | "machine", value: string): string {
  const salt = process.env.DX_FAKE_HASH_SALT ? "\\0" + process.env.DX_FAKE_HASH_SALT : "";
  return fakeHash(kind, value + salt);
}

function writeCacheOutput(input: string, outputDir: string): void {
  const normalizedInput = input.replaceAll("\\\\", "/").replace(/^\\.\\//, "");
  const stem = cacheStem(input);
  fs.mkdirSync(outputDir, { recursive: true });

  if (process.env.DX_SKIP_MACHINE_FOR !== normalizedInput) {
    fs.writeFileSync(path.join(outputDir, stem + ".machine"), Buffer.from("DXM1fake-machine"));
  }

  if (process.env.DX_SKIP_META_FOR !== normalizedInput) {
    const sourcePath = path.join(process.cwd(), input);
    const sourceBytes = fs.readFileSync(sourcePath);
    const machineBytes = fs.readFileSync(path.join(outputDir, stem + ".machine"));
    const sourceBlake3 = process.env.DX_BAD_SOURCE_HASH_FOR === normalizedInput ? "SOURCE-" + stem : saltedFakeHash("source", normalizedInput);
    const machineBlake3 = process.env.DX_BAD_MACHINE_HASH_FOR === normalizedInput ? "MACHINE-" + stem : saltedFakeHash("machine", stem);
    const machineByteCount = process.env.DX_BAD_MACHINE_BYTES_FOR === normalizedInput ? machineBytes.length + 1 : machineBytes.length;
    fs.writeFileSync(
      path.join(outputDir, stem + ".machine.meta.json"),
      JSON.stringify(
        {
          schema: "dx.machine.source_metadata.v1",
          source: {
            path: normalizedInput,
            bytes: sourceBytes.length,
            modified_unix_ms: 1700000000000,
            blake3: sourceBlake3,
          },
          machine: {
            path: stem + ".machine",
            bytes: machineByteCount,
            blake3: machineBlake3,
          },
          cache: {
            rebuildable: true,
            fallback_on_mismatch: true,
          },
        },
        null,
        2,
      ),
    );
  }
}

const args = process.argv.slice(2);
appendJsonLine(${JSON.stringify(serializerCallLog)}, { args });

if (args[0] === "--write-js-cache-artifacts") {
  if (process.env.DX_FAIL_ARTIFACT_WRITER === "1") {
    console.error("fake dx-serialize artifact writer failed intentionally");
    process.exit(94);
  }

  if (process.env.DX_ARTIFACT_WRITER_NOISY_STDERR === "1") {
    process.stderr.write("artifact-writer-noise\\n".repeat(16384));
  }

  const catalogFlag = args.indexOf("--catalog-json");
  const outputFlag = args.indexOf("--output-dir");
  const shardRootFlag = args.indexOf("--js-cache-shard-root");
  if (catalogFlag === -1 || outputFlag === -1 || shardRootFlag === -1) {
    console.error("fake dx-serialize artifact writer received unexpected args", JSON.stringify(args));
    process.exit(92);
  }

  const catalogJsonPath = args[catalogFlag + 1];
  const outputDir = args[outputFlag + 1];
  const shardRoot = args[shardRootFlag + 1];
  if (!shardRoot || shardRoot.includes(".artifacts.")) {
    console.error("fake dx-serialize artifact writer received non-final shard root", JSON.stringify(args));
    process.exit(96);
  }
  const catalogText = fs.readFileSync(catalogJsonPath, "utf8");
  const catalog = JSON.parse(catalogText) as { shards: string[] };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "catalog.machine"), Buffer.from("FAKE-RKYV-CATALOG\\n" + catalogText));

  for (const shard of catalog.shards) {
    const shardPath = path.join(outputDir, "shards", ...shard.split("/")) + ".dxjs";
    fs.mkdirSync(path.dirname(shardPath), { recursive: true });
    fs.writeFileSync(shardPath, Buffer.from("FAKE-RKYV-SHARD\\n" + shard + "\\n"));
  }

  if (process.env.DX_FAIL_ARTIFACT_WRITER_AFTER_PARTIAL === "1") {
    console.error("fake dx-serialize artifact writer failed after partial output intentionally");
    process.exit(95);
  }

  process.exit(0);
}

if (args[0] === "--inputs-file") {
  const inputsFile = args[1];
  const outputFlag = args.indexOf("--output-dir");
  const outputDir = outputFlag === -1 ? undefined : args[outputFlag + 1];
  if (!inputsFile || !outputDir) {
    console.error("fake dx-serialize received unexpected inputs-file args", JSON.stringify(args));
    process.exit(93);
  }

  const inputs = fs.readFileSync(inputsFile, "utf8").split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
  for (const input of inputs) {
    writeCacheOutput(input, outputDir);
  }
  process.exit(0);
}

const input = args[0];
const outputFlag = args.indexOf("--output-dir");
const outputDir = outputFlag === -1 ? undefined : args[outputFlag + 1];
if (!input || !outputDir) {
  console.error("fake dx-serialize received unexpected args", JSON.stringify(args));
  process.exit(91);
}

writeCacheOutput(input, outputDir);
`,
  );

  return {
    repo,
    manifest: path.join(serializer, "Cargo.toml"),
    script: path.join(scripts, "dx-js-machine-cache.ps1"),
    bin,
  };
}

function runPowerShell(
  fixture: Fixture,
  args: string[],
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const pathEnv = `${fixture.bin}${path.delimiter}${process.env.PATH || process.env.Path || ""}`;

  return spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture.script, ...args],
    {
      cwd: fixture.repo,
      env: {
        ...process.env,
        PATH: pathEnv,
        Path: pathEnv,
        DX_SERIALIZER_MANIFEST: fixture.manifest,
        ...extraEnv,
      },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
}

function stdoutLines(result: SpawnSyncReturns<string>): string[] {
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("WARNING:"));
}

function readJsonLines<T>(target: string): T[] {
  if (!fs.existsSync(target)) {
    return [];
  }

  return fs
    .readFileSync(target, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function serializerInputCalls<T extends { args: string[] }>(calls: T[]): T[] {
  return calls.filter((call) => call.args[0] !== "--write-js-cache-artifacts");
}

function serializerArtifactCalls<T extends { args: string[] }>(calls: T[]): T[] {
  return calls.filter((call) => call.args[0] === "--write-js-cache-artifacts");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeTestRoot(): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) {
        throw error;
      }
      sleepSync(50 * (attempt + 1));
    }
  }
}

function expectSuccess(result: SpawnSyncReturns<string>): void {
  if (result.status !== 0) {
    throw new Error(result.stderr + result.stdout);
  }
}

afterAll(() => {
  removeTestRoot();
});

test("lists bounded cache inputs without invoking cargo", () => {
  const fixture = setupRepo("list-inputs");
  const result = runPowerShell(
    fixture,
    ["-ListInputsOnly", "-NoIndex", "-MaxWorkspacePackages", "1"],
    { DX_FAIL_ON_CARGO: "1" },
  );

  expectSuccess(result);
  expect(stdoutLines(result)).toEqual([
    "package.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "jsconfig.json",
    "bunfig.toml",
    "bunfig.node-test.toml",
    "packages/pkg-a/package.json",
    "single-package/package.json",
  ]);
}, processTestTimeout);

test("lists cache inputs without requiring serializer manifest or output directory writes", () => {
  const fixture = setupRepo("list-inputs-missing-manifest");
  const outputDir = path.join(fixture.repo, ".dx", "js-list-only-missing-manifest");
  const result = runPowerShell(
    fixture,
    ["-ListInputsOnly", "-NoIndex", "-OutputDir", ".dx\\js-list-only-missing-manifest"],
    {
      DX_FAIL_ON_CARGO: "1",
      DX_SERIALIZER_MANIFEST: path.join(fixture.repo, "missing-serializer", "Cargo.toml"),
    },
  );

  expectSuccess(result);
  expect(stdoutLines(result)).toContain("package.json");
  expect(fs.existsSync(outputDir)).toBe(false);
}, processTestTimeout);

test("rejects absolute and parent-traversal cache inputs before generation", () => {
  const fixture = setupRepo("unsafe-inputs");
  const absoluteResult = runPowerShell(
    fixture,
    ["-ListInputsOnly", "-NoIndex", "-Inputs", "G:\\outside\\package.json"],
    { DX_FAIL_ON_CARGO: "1" },
  );
  expect(absoluteResult.status).not.toBe(0);
  expect(absoluteResult.stderr + absoluteResult.stdout).toContain("input must be repo-relative");

  const traversalResult = runPowerShell(
    fixture,
    ["-ListInputsOnly", "-NoIndex", "-Inputs", "..\\package.json"],
    { DX_FAIL_ON_CARGO: "1" },
  );
  expect(traversalResult.status).not.toBe(0);
  expect(traversalResult.stderr + traversalResult.stdout).toContain("input must stay inside the repo");
}, processTestTimeout);

test("rejects unsafe workspace patterns before expansion", () => {
  const fixture = setupRepo("unsafe-workspace");
  writeFile(
    path.join(fixture.repo, "package.json"),
    JSON.stringify({ name: "fake-workspace", workspaces: ["..\\outside"] }, null, 2),
  );

  const result = runPowerShell(
    fixture,
    ["-ListInputsOnly", "-NoIndex"],
    { DX_FAIL_ON_CARGO: "1" },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("workspace pattern must stay inside the repo");
}, processTestTimeout);

test("writes a stable index for generated machine cache artifacts", () => {
  const fixture = setupRepo("index");
  const result = runPowerShell(fixture, ["-OutputDir", ".dx\\js-test", "-MaxWorkspacePackages", "2"]);

  expectSuccess(result);

  const indexPath = path.join(fixture.repo, ".dx", "js-test", "index.json");
  const catalogPath = path.join(fixture.repo, ".dx", "js-test", "catalog.json");
  const catalogMachinePath = path.join(fixture.repo, ".dx", "js-test", "catalog.machine");
  const packageSourceHash = fakeMetadataHash("source", "package.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as CacheIndex;
  const catalogJson = fs.readFileSync(catalogPath, "utf8");
  const catalog = JSON.parse(catalogJson) as CacheCatalog;
  const sources = index.entries.map((entry) => entry.source);
  const packageCatalogEntry = catalog.entries.find((entry) => entry.source === "package.json");
  expect(packageCatalogEntry).toBeDefined();
  const packageShard = packageCatalogEntry!.shard;
  const packageShardPath = path.join(fixture.repo, ".dx", "js-test", "shards", ...packageShard.split("/")) + ".dxjs";

  expect(index.schema).toBe("dx.js.machine_cache_index.v1");
  expect(index.generatedAtUtc.length).toBeGreaterThan(0);
  expect((index as CacheIndex & { serializer?: { schema?: string; bin?: string } }).serializer).toMatchObject({
    schema: "dx.js.machine_cache_serializer.v1",
    bin: "dx-serialize",
    evidenceLock: {
      schema: "dx.serializer.evidence_lock.verification.v1",
      fileCount: 1,
      scope: "declared-files-only",
      completeSourceCoverage: false,
    },
  });
  expect(sources).toEqual([
    "package.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "jsconfig.json",
    "bunfig.toml",
    "bunfig.node-test.toml",
    "packages/pkg-a/package.json",
    "packages/pkg-b/package.json",
    "single-package/package.json",
  ]);

  for (const entry of index.entries) {
    const expectedKind =
      entry.source.endsWith("/package.json") || entry.source === "package.json"
        ? "package_json"
        : entry.source.endsWith(".toml")
          ? "bunfig"
          : "tsconfig";

    expect(entry.kind).toBe(expectedKind);
    expect(entry.machine.includes("\\")).toBe(false);
    expect(entry.metadata.includes("\\")).toBe(false);
    expect(entry.sourceBytes).toBeGreaterThan(0);
    expect(entry.sourceModifiedUnixMs).toBe(1700000000000);
    expect(entry.sourceBlake3).toBe(fakeMetadataHash("source", entry.source));
    expect(entry.machineBlake3).toBe(fakeMetadataHash("machine", entry.stem));
    expect(entry.machineBytes).toBeGreaterThan(0);
    expect(entry.metadataBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(fixture.repo, entry.machine))).toBe(true);
    expect(fs.existsSync(path.join(fixture.repo, entry.metadata))).toBe(true);
  }

  expect(catalog.schema).toBe("dx.js.machine_cache_catalog.v1");
  expect(catalog.generatedAtUtc).toBe(index.generatedAtUtc);
  expect((catalog as CacheCatalog & { serializer?: { schema?: string; bin?: string } }).serializer).toMatchObject({
    schema: "dx.js.machine_cache_serializer.v1",
    bin: "dx-serialize",
    evidenceLock: {
      schema: "dx.serializer.evidence_lock.verification.v1",
      fileCount: 1,
      scope: "declared-files-only",
      completeSourceCoverage: false,
    },
  });
  expect(catalog.shards).toEqual([...catalog.shards].sort());
  expect(catalog.entries.map((entry) => entry.key)).toEqual(
    [...catalog.entries.map((entry) => entry.key)].sort(),
  );
  for (const entry of catalog.entries) {
    const indexEntry = index.entries.find((candidate) => candidate.source === entry.source);
    expect(indexEntry).toBeDefined();
    expect(entry.machine.includes("\\")).toBe(false);
    expect(entry.metadata.includes("\\")).toBe(false);
    if (entry.keyInterning) {
      expect(entry.keyInterning.includes("\\")).toBe(false);
    }
    expect(entry.sourceBytes).toBe(indexEntry!.sourceBytes);
    expect(entry.sourceModifiedUnixMs).toBe(indexEntry!.sourceModifiedUnixMs);
    expect(entry.sourceBlake3).toBe(indexEntry!.sourceBlake3);
    expect(entry.machineBlake3).toBe(indexEntry!.machineBlake3);
    expect(entry.machineBytes).toBe(indexEntry!.machineBytes);
    expect(entry.metadataBytes).toBe(indexEntry!.metadataBytes);
  }
  expect(packageCatalogEntry).toMatchObject({
    key: "package_json\0package.json",
    kind: "package_json",
    shard: expect.stringMatching(/^package_json\/[0-9a-f]{16}$/),
    sourceBlake3: packageSourceHash,
    keyInterning: ".dx/js-test/package-json.keys.json",
  });
  expect(catalog.shards).toContain(packageShard);

  const packageEntry = index.entries.find((entry) => entry.source === "package.json");
  expect(packageEntry?.keyInterning).toBe(".dx/js-test/package-json.keys.json");
  const keyInterning = JSON.parse(
    fs.readFileSync(path.join(fixture.repo, packageEntry!.keyInterning!), "utf8"),
  ) as {
    schema: string;
    sourceFormat: string;
    keyEncoding: string;
    objectKeyOccurrences: number;
    uniqueKeys: number;
    keys: Array<{ key: string; occurrences: number }>;
  };
  expect(keyInterning).toMatchObject({
    schema: "dx.package_json.key_interning_sidecar.v1",
    sourceFormat: "package_json",
    keyEncoding: "utf8",
    objectKeyOccurrences: 2,
    uniqueKeys: 2,
  });
  expect(keyInterning.keys).toHaveLength(2);
  expect(keyInterning.keys[0]).toMatchObject({ key: "name", occurrences: 1 });
  expect(keyInterning.keys[1]).toMatchObject({ key: "workspaces", occurrences: 1 });

  const serializerCalls = readJsonLines<{ args: string[] }>(path.join(fixture.repo, serializerCallLog));
  const artifactCalls = serializerArtifactCalls(serializerCalls);
  expect(artifactCalls).toHaveLength(1);
  expect(artifactCalls[0].args).toContain("--write-js-cache-artifacts");
  expect(artifactCalls[0].args).toContain("--catalog-json");
  const catalogArg = artifactCalls[0].args[artifactCalls[0].args.indexOf("--catalog-json") + 1];
  expect(catalogArg).not.toBe(catalogPath);
  expect(path.dirname(catalogArg)).toBe(path.dirname(catalogPath));
  expect(path.basename(catalogArg).startsWith("catalog.")).toBe(true);
  expect(catalogArg.endsWith(".tmp")).toBe(true);
  expect(artifactCalls[0].args).toContain("--output-dir");
  const outputArg = artifactCalls[0].args[artifactCalls[0].args.indexOf("--output-dir") + 1];
  const finalOutputDir = path.join(fixture.repo, ".dx", "js-test");
  expect(path.dirname(outputArg)).toBe(finalOutputDir);
  expect(path.basename(outputArg).startsWith(".artifacts.")).toBe(true);
  expect(outputArg.endsWith(".tmp")).toBe(true);

  const catalogMachine = fs.readFileSync(catalogMachinePath);
  expect(catalogMachine.subarray(0, 8).toString("ascii")).not.toBe("DXJSCAT1");
  expect(catalogMachine.toString("utf8").startsWith("FAKE-RKYV-CATALOG\n")).toBe(true);
  expect(JSON.parse(catalogMachine.toString("utf8").split("\n").slice(1).join("\n"))).toEqual(catalog);

  const packageShardFile = fs.readFileSync(packageShardPath);
  expect(packageShardFile.toString("utf8")).toBe(`FAKE-RKYV-SHARD\n${packageShard}\n`);
}, processTestTimeout);

test("rejects duplicate machine cache stems before invoking cargo", () => {
  const fixture = setupRepo("duplicate-stems");
  writeFile(path.join(fixture.repo, "packages", "a", "package.json"), "{\"name\":\"a\"}\n");
  writeFile(path.join(fixture.repo, "packages-a", "package.json"), "{\"name\":\"packages-a\"}\n");

  const result = runPowerShell(fixture, [
    "-OutputDir",
    ".dx\\js-duplicate-stems",
    "-NoWorkspacePackages",
    "-Inputs",
    "packages/a/package.json,packages-a/package.json",
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("Duplicate DX JS machine cache stem");
  expect(fs.existsSync(path.join(fixture.repo, cargoCallLog))).toBe(false);
}, processTestTimeout);

test("rejects invalid serializer metadata before publishing manifests", () => {
  const fixture = setupRepo("bad-metadata");
  const result = runPowerShell(
    fixture,
    ["-OutputDir", ".dx\\js-bad-metadata", "-NoWorkspacePackages", "-NoIndex", "-Inputs", "package.json"],
    { DX_BAD_SOURCE_HASH_FOR: "package.json" },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("Expected lowercase 64-hex source blake3");
  expect(fs.existsSync(path.join(fixture.repo, ".dx", "js-bad-metadata", "index.json"))).toBe(false);
}, processTestTimeout);

test("rejects serializer evidence lock drift before building serializer", () => {
  const fixture = setupRepo("serializer-lock-drift");
  writeFile(path.join(fixture.repo, "serializer", "Cargo.toml"), "[package]\nname = \"drifted\"\n");

  const result = runPowerShell(fixture, ["-OutputDir", ".dx\\js-lock-drift", "-NoWorkspacePackages", "-Inputs", "package.json"]);

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("DX serializer evidence drift");
  expect(fs.existsSync(path.join(fixture.repo, cargoCallLog))).toBe(false);
  expect(fs.existsSync(path.join(fixture.repo, ".dx", "js-lock-drift", "index.json"))).toBe(false);
}, processTestTimeout);

test("rejects serializer evidence paths that cross reparse points before building serializer", () => {
  const fixture = setupRepo("serializer-lock-reparse");
  const outsideManifest = "[package]\nname = \"outside-evidence\"\n";
  const outsideFile = path.join(fixture.repo, "outside-evidence", "Cargo.toml");
  const linkedDir = path.join(fixture.repo, "serializer", "linked");

  writeFile(outsideFile, outsideManifest);
  fs.symlinkSync(path.dirname(outsideFile), linkedDir, "junction");
  writeFile(
    path.join(fixture.repo, "scripts", "dx-serializer-evidence-lock.json"),
    JSON.stringify(
      {
        schema: "dx.serializer.external_evidence_lock.v1",
        files: [
          {
            path: "linked/Cargo.toml",
            bytes: Buffer.byteLength(outsideManifest),
            sha256: sha256Text(outsideManifest),
            reason: "Must not trust serializer evidence through reparse points.",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );

  const result = runPowerShell(
    fixture,
    ["-OutputDir", ".dx\\js-lock-reparse", "-NoWorkspacePackages", "-Inputs", "package.json"],
    { DX_FAIL_ON_CARGO: "1" },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("DX serializer evidence path crosses a reparse point");
  expect(fs.existsSync(path.join(fixture.repo, cargoCallLog))).toBe(false);
  expect(fs.existsSync(path.join(fixture.repo, ".dx", "js-lock-reparse", "index.json"))).toBe(false);
}, processTestTimeout);

test("rejects serializer executable override unless explicitly waived", () => {
  const fixture = setupRepo("serializer-exe-override");
  const fakeExe = path.join(fixture.bin, "manual-dx-serialize.cmd");
  writeFile(fakeExe, "@echo off\r\nexit /b 77\r\n");

  const result = runPowerShell(
    fixture,
    ["-OutputDir", ".dx\\js-exe-override", "-NoWorkspacePackages", "-Inputs", "package.json"],
    { DX_SERIALIZER_EXE: fakeExe, DX_FAIL_ON_CARGO: "1" },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("DX serializer executable override is unpinned");
  expect(fs.existsSync(path.join(fixture.repo, cargoCallLog))).toBe(false);
  expect(fs.existsSync(path.join(fixture.repo, ".dx", "js-exe-override", "index.json"))).toBe(false);
}, processTestTimeout);

test("marks waived serializer executable override as unverified evidence", () => {
  const fixture = setupRepo("serializer-exe-override-waived");
  const fakeExe = path.join(fixture.bin, "manual-dx-serialize.cmd");
  writeFile(fakeExe, '@echo off\r\nbun "%~dp0fake-dx-serialize.ts" %*\r\n');

  const result = runPowerShell(
    fixture,
    ["-OutputDir", ".dx\\js-exe-override-waived", "-NoWorkspacePackages", "-Inputs", "package.json"],
    {
      DX_SERIALIZER_EXE: fakeExe,
      DX_SERIALIZER_EVIDENCE_ALLOW_UNPINNED: "1",
      DX_FAIL_ON_CARGO: "1",
    },
  );

  expectSuccess(result);
  expect(fs.existsSync(path.join(fixture.repo, cargoCallLog))).toBe(false);

  const index = JSON.parse(
    fs.readFileSync(path.join(fixture.repo, ".dx", "js-exe-override-waived", "index.json"), "utf8"),
  ) as CacheIndex & { serializer?: { evidenceLock?: Record<string, unknown> } };
  const catalog = JSON.parse(
    fs.readFileSync(path.join(fixture.repo, ".dx", "js-exe-override-waived", "catalog.json"), "utf8"),
  ) as CacheCatalog & { serializer?: { evidenceLock?: Record<string, unknown> } };
  const expectedWaiver = {
    schema: "dx.serializer.evidence_lock.verification.v1",
    waived: true,
    reason: "DX_SERIALIZER_EVIDENCE_ALLOW_UNPINNED",
    scope: "unverified-executable-override",
    executableOverride: true,
    completeSourceCoverage: false,
    fileCount: 0,
  };

  expect(index.serializer?.evidenceLock).toMatchObject(expectedWaiver);
  expect(catalog.serializer?.evidenceLock).toMatchObject(expectedWaiver);
  expect(index.serializer?.evidenceLock?.path).toBeUndefined();
  expect(index.serializer?.evidenceLock?.sha256).toBeUndefined();
}, processTestTimeout);

test("rejects cmd serializer arguments with shell metacharacters", () => {
  const fixture = setupRepo("serializer-cmd-metachar-input");
  const fakeExe = path.join(fixture.bin, "manual-dx-serialize.cmd");
  writeFile(fakeExe, '@echo off\r\nbun "%~dp0fake-dx-serialize.ts" %*\r\n');
  writeFile(path.join(fixture.repo, "unsafe&input.json"), "{}\n");

  const result = runPowerShell(
    fixture,
    ["-OutputDir", ".dx\\js-cmd-metachar", "-NoWorkspacePackages", "-Inputs", "unsafe&input.json"],
    {
      DX_SERIALIZER_EXE: fakeExe,
      DX_SERIALIZER_EVIDENCE_ALLOW_UNPINNED: "1",
      DX_FAIL_ON_CARGO: "1",
    },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("refusing to execute via cmd.exe");
  expect(fs.existsSync(path.join(fixture.repo, serializerCallLog))).toBe(false);
  expect(fs.existsSync(path.join(fixture.repo, ".dx", "js-cmd-metachar", "index.json"))).toBe(false);
}, processTestTimeout);

test("preserves existing manifests when binary artifact generation fails", () => {
  const fixture = setupRepo("artifact-failure");
  const outputDir = path.join(fixture.repo, ".dx", "js-artifact-failure");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "index.json"), "OLD-INDEX\n");
  fs.writeFileSync(path.join(outputDir, "catalog.json"), "OLD-CATALOG\n");

  const result = runPowerShell(
    fixture,
    ["-OutputDir", ".dx\\js-artifact-failure", "-NoWorkspacePackages", "-Inputs", "package.json"],
    { DX_FAIL_ARTIFACT_WRITER: "1" },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("fake dx-serialize artifact writer failed intentionally");
  expect(fs.readFileSync(path.join(outputDir, "index.json"), "utf8")).toBe("OLD-INDEX\n");
  expect(fs.readFileSync(path.join(outputDir, "catalog.json"), "utf8")).toBe("OLD-CATALOG\n");
}, processTestTimeout);

test("preserves existing binary artifacts when artifact generation fails after partial output", () => {
  const fixture = setupRepo("artifact-partial-failure");
  const outputDir = path.join(fixture.repo, ".dx", "js-artifact-partial-failure");
  const shardPath = path.join(outputDir, "shards", ...fakeCatalogShard("package.json", "package_json").split("/")) + ".dxjs";
  fs.mkdirSync(path.dirname(shardPath), { recursive: true });
  fs.writeFileSync(path.join(outputDir, "catalog.machine"), "OLD-CATALOG-MACHINE\n");
  fs.writeFileSync(shardPath, "OLD-SHARD\n");

  const result = runPowerShell(
    fixture,
    ["-OutputDir", ".dx\\js-artifact-partial-failure", "-NoWorkspacePackages", "-Inputs", "package.json"],
    { DX_FAIL_ARTIFACT_WRITER_AFTER_PARTIAL: "1" },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain(
    "fake dx-serialize artifact writer failed after partial output intentionally",
  );
  expect(fs.readFileSync(path.join(outputDir, "catalog.machine"), "utf8")).toBe("OLD-CATALOG-MACHINE\n");
  expect(fs.readFileSync(shardPath, "utf8")).toBe("OLD-SHARD\n");
}, processTestTimeout);

test("publishes changed binary shards with immutable content-addressed paths", () => {
  const fixture = setupRepo("artifact-immutable-shards");
  const outputDir = path.join(fixture.repo, ".dx", "js-artifact-immutable-shards");
  const args = ["-OutputDir", ".dx\\js-artifact-immutable-shards", "-NoWorkspacePackages", "-Inputs", "package.json"];

  const first = runPowerShell(fixture, args, { DX_FAKE_HASH_SALT: "first" });
  expectSuccess(first);
  const firstCatalog = JSON.parse(fs.readFileSync(path.join(outputDir, "catalog.json"), "utf8")) as CacheCatalog;
  const firstShard = firstCatalog.entries.find((entry) => entry.source === "package.json")!.shard;
  const firstShardPath = path.join(outputDir, "shards", ...firstShard.split("/")) + ".dxjs";
  const firstShardBytes = fs.readFileSync(firstShardPath, "utf8");

  const second = runPowerShell(fixture, args, { DX_FAKE_HASH_SALT: "second" });
  expectSuccess(second);
  const secondCatalog = JSON.parse(fs.readFileSync(path.join(outputDir, "catalog.json"), "utf8")) as CacheCatalog;
  const secondShard = secondCatalog.entries.find((entry) => entry.source === "package.json")!.shard;
  const secondShardPath = path.join(outputDir, "shards", ...secondShard.split("/")) + ".dxjs";

  expect(firstShard).toMatch(/^package_json\/[0-9a-f]{16}$/);
  expect(secondShard).toMatch(/^package_json\/[0-9a-f]{16}$/);
  expect(secondShard).not.toBe(firstShard);
  expect(fs.readFileSync(firstShardPath, "utf8")).toBe(firstShardBytes);
  expect(fs.existsSync(secondShardPath)).toBe(true);
  expect(secondCatalog.shards).toContain(secondShard);
  expect(secondCatalog.shards).not.toContain(firstShard);
  const artifactCalls = serializerArtifactCalls<{ args: string[] }>(
    readJsonLines<{ args: string[] }>(path.join(fixture.repo, serializerCallLog)),
  );
  const finalCallArgs = artifactCalls.at(-1)!.args;
  expect(finalCallArgs).toContain("--js-cache-shard-root");
  expect(finalCallArgs[finalCallArgs.indexOf("--js-cache-shard-root") + 1].replaceAll("\\", "/")).toBe(
    ".dx/js-artifact-immutable-shards/shards",
  );
}, processTestTimeout);

test("can coalesce trusted catalog shards to reduce runtime fanout", () => {
  const fixture = setupRepo("artifact-coarse-shards");
  const outputDir = path.join(fixture.repo, ".dx", "js-artifact-coarse-shards");
  const result = runPowerShell(fixture, [
    "-OutputDir",
    ".dx\\js-artifact-coarse-shards",
    "-MaxWorkspacePackages",
    "2",
    "-ShardSourceHashPrefixLength",
    "0",
  ]);

  expectSuccess(result);
  const catalog = JSON.parse(fs.readFileSync(path.join(outputDir, "catalog.json"), "utf8")) as CacheCatalog;
  const packageShards = [
    ...new Set(catalog.entries.filter((entry) => entry.kind === "package_json").map((entry) => entry.shard)),
  ];

  expect(packageShards).toHaveLength(1);
  expect(packageShards[0]).toMatch(/^package_json\/[0-9a-f]{16}$/);
  expect(fs.existsSync(path.join(outputDir, "shards", ...packageShards[0].split("/")) + ".dxjs")).toBe(true);
}, processTestTimeout);

test("can opt into source-hash-prefixed trusted catalog shards", () => {
  const fixture = setupRepo("artifact-prefixed-shards");
  const outputDir = path.join(fixture.repo, ".dx", "js-artifact-prefixed-shards");
  const result = runPowerShell(fixture, [
    "-OutputDir",
    ".dx\\js-artifact-prefixed-shards",
    "-NoWorkspacePackages",
    "-Inputs",
    "package.json",
    "-ShardSourceHashPrefixLength",
    "2",
  ]);

  expectSuccess(result);
  const catalog = JSON.parse(fs.readFileSync(path.join(outputDir, "catalog.json"), "utf8")) as CacheCatalog;
  const packageShard = catalog.entries.find((entry) => entry.source === "package.json")!.shard;

  expect(packageShard).toMatch(/^package_json\/[0-9a-f]{2}\/[0-9a-f]{16}$/);
  expect(packageShard).toBe(fakeCatalogShard("package.json", "package_json", 2));
  expect(fs.existsSync(path.join(outputDir, "shards", ...packageShard.split("/")) + ".dxjs")).toBe(true);
}, processTestTimeout);

test("drains artifact writer stderr while publishing manifests", () => {
  const fixture = setupRepo("artifact-noisy-stderr");
  const result = runPowerShell(
    fixture,
    ["-OutputDir", ".dx\\js-artifact-noisy-stderr", "-NoWorkspacePackages", "-Inputs", "package.json"],
    { DX_ARTIFACT_WRITER_NOISY_STDERR: "1" },
  );

  expectSuccess(result);
  expect(fs.existsSync(path.join(fixture.repo, ".dx", "js-artifact-noisy-stderr", "catalog.machine"))).toBe(true);
}, processTestTimeout);

test("publishes empty indexed artifacts when no requested inputs exist", () => {
  const fixture = setupRepo("empty-indexed-artifacts");
  const result = runPowerShell(fixture, [
    "-OutputDir",
    ".dx\\js-empty-index",
    "-NoWorkspacePackages",
    "-Inputs",
    "missing-package.json",
  ]);

  expectSuccess(result);

  const outputDir = path.join(fixture.repo, ".dx", "js-empty-index");
  const index = JSON.parse(fs.readFileSync(path.join(outputDir, "index.json"), "utf8")) as CacheIndex;
  const catalog = JSON.parse(fs.readFileSync(path.join(outputDir, "catalog.json"), "utf8")) as CacheCatalog;
  const serializerCalls = readJsonLines<{ args: string[] }>(path.join(fixture.repo, serializerCallLog));

  expect(index.entries).toEqual([]);
  expect(catalog.entries).toEqual([]);
  expect(catalog.shards).toEqual([]);
  expect(serializerInputCalls(serializerCalls)).toHaveLength(0);
  expect(serializerArtifactCalls(serializerCalls)).toHaveLength(1);
  expect(fs.existsSync(path.join(outputDir, "catalog.machine"))).toBe(true);
}, processTestTimeout);

test("builds dx-serialize once and executes the built binary with an inputs file batch", () => {
  const fixture = setupRepo("build-contract");
  const result = runPowerShell(fixture, [
    "-OutputDir",
    ".dx\\js-build-contract",
    "-NoWorkspacePackages",
    "-MaxParallelSerializers",
    "1",
    "-Inputs",
    "package.json,tsconfig.json,bunfig.toml",
  ]);

  expectSuccess(result);

  const cargoCalls = readJsonLines<{ args: string[] }>(path.join(fixture.repo, cargoCallLog));
  expect(cargoCalls).toHaveLength(1);
  expect(cargoCalls[0].args[0]).toBe("build");
  expect(cargoCalls[0].args).toContain("--locked");
  expect(cargoCalls[0].args).toContain("--manifest-path");
  expect(cargoCalls[0].args).toContain(fixture.manifest);
  expect(cargoCalls[0].args).toContain("--bin");
  expect(cargoCalls[0].args).toContain("dx-serialize");

  const serializerCalls = readJsonLines<{ args: string[] }>(path.join(fixture.repo, serializerCallLog));
  const inputCalls = serializerInputCalls(serializerCalls);
  expect(inputCalls).toHaveLength(1);
  expect(inputCalls[0].args[0]).toBe("--inputs-file");
  expect(inputCalls[0].args[1]).toEndWith(".txt");
  expect(serializerArtifactCalls(serializerCalls)).toHaveLength(1);
  for (const call of inputCalls) {
    expect(call.args).toContain("--js-cache");
    expect(call.args).toContain("--machine-only");
    expect(call.args).toContain("--metadata");
    expect(call.args).toContain("--no-compression");
    expect(call.args).toContain("--output-dir");
    expect(call.args).toContain(path.join(fixture.repo, ".dx", "js-build-contract"));
  }

  const index = JSON.parse(
    fs.readFileSync(path.join(fixture.repo, ".dx", "js-build-contract", "index.json"), "utf8"),
  ) as CacheIndex;
  expect(index.entries.map((entry) => entry.source)).toEqual(["package.json", "tsconfig.json", "bunfig.toml"]);
}, processTestTimeout);

test("keeps serializer no-compression on hot cache writes", () => {
  const fixture = setupRepo("default-no-compression");
  const result = runPowerShell(fixture, [
    "-OutputDir",
    ".dx\\js-default-no-compression",
    "-NoWorkspacePackages",
    "-MaxParallelSerializers",
    "1",
    "-Inputs",
    "package.json",
  ]);

  expectSuccess(result);

  const serializerCalls = readJsonLines<{ args: string[] }>(path.join(fixture.repo, serializerCallLog));
  const inputCalls = serializerInputCalls(serializerCalls);
  expect(inputCalls).toHaveLength(1);
  expect(serializerArtifactCalls(serializerCalls)).toHaveLength(1);
  expect(inputCalls[0].args).toContain("--no-compression");
  expect(inputCalls[0].args).toContain("--output-dir");
  expect(inputCalls[0].args).toContain(path.join(fixture.repo, ".dx", "js-default-no-compression"));
}, processTestTimeout);

test("reruns only cold large structured shards with opt-in compression", () => {
  const fixture = setupRepo("cold-large-compression");
  const result = runPowerShell(fixture, [
    "-OutputDir",
    ".dx\\js-cold-large",
    "-NoWorkspacePackages",
    "-MaxParallelSerializers",
    "1",
    "-Inputs",
    "package.json,tooling.toml",
    "-ColdLargeShardCompression",
    "zstd",
    "-ColdLargeShardMinMachineBytes",
    "10",
    "-ColdLargeShardPatterns",
    "structured/*",
  ]);

  expectSuccess(result);

  const serializerCalls = readJsonLines<{ args: string[] }>(path.join(fixture.repo, serializerCallLog));
  const inputCalls = serializerInputCalls(serializerCalls);
  expect(inputCalls.map((call) => call.args[0])).toEqual(["--inputs-file", "tooling.toml"]);
  expect(serializerArtifactCalls(serializerCalls)).toHaveLength(1);

  const initialBatchCall = inputCalls[0].args;
  expect(initialBatchCall).toContain("--no-compression");
  expect(initialBatchCall).not.toContain("--zstd");

  const compressedStructuredCall = inputCalls[1].args;
  expect(compressedStructuredCall).toContain("--zstd");
  expect(compressedStructuredCall).not.toContain("--no-compression");

  const index = JSON.parse(
    fs.readFileSync(path.join(fixture.repo, ".dx", "js-cold-large", "index.json"), "utf8"),
  ) as CacheIndex;
  expect(index.entries.map((entry) => [entry.source, entry.kind])).toEqual([
    ["package.json", "package_json"],
    ["tooling.toml", "structured"],
  ]);
}, processTestTimeout);

test("NoCompression suppresses opt-in cold shard recompression", () => {
  const fixture = setupRepo("no-compression-overrides-cold-large");
  const result = runPowerShell(fixture, [
    "-OutputDir",
    ".dx\\js-no-compression-overrides-cold-large",
    "-NoWorkspacePackages",
    "-MaxParallelSerializers",
    "1",
    "-Inputs",
    "package.json,tooling.toml",
    "-NoCompression",
    "-ColdLargeShardCompression",
    "zstd",
    "-ColdLargeShardMinMachineBytes",
    "10",
    "-ColdLargeShardPatterns",
    "structured/*",
  ]);

  expectSuccess(result);

  const serializerCalls = readJsonLines<{ args: string[] }>(path.join(fixture.repo, serializerCallLog));
  const inputCalls = serializerInputCalls(serializerCalls);
  expect(inputCalls.map((call) => call.args[0])).toEqual(["--inputs-file"]);
  expect(serializerArtifactCalls(serializerCalls)).toHaveLength(1);

  expect(inputCalls[0].args).toContain("--no-compression");
  expect(inputCalls[0].args).not.toContain("--zstd");
}, processTestTimeout);

test("does not cold-compress trusted cache kinds even when explicitly patterned", () => {
  const fixture = setupRepo("trusted-kind-compression-block");
  const result = runPowerShell(fixture, [
    "-OutputDir",
    ".dx\\js-trusted-kind-compression-block",
    "-NoWorkspacePackages",
    "-MaxParallelSerializers",
    "1",
    "-Inputs",
    "package.json,tsconfig.json,bunfig.toml,tooling.toml",
    "-ColdLargeShardCompression",
    "zstd",
    "-ColdLargeShardMinMachineBytes",
    "10",
    "-ColdLargeShardPatterns",
    "*/*",
  ]);

  expectSuccess(result);

  const serializerCalls = readJsonLines<{ args: string[] }>(path.join(fixture.repo, serializerCallLog));
  const inputCalls = serializerInputCalls(serializerCalls);
  expect(inputCalls.map((call) => call.args[0])).toEqual(["--inputs-file", "tooling.toml"]);
  expect(serializerArtifactCalls(serializerCalls)).toHaveLength(1);

  expect(inputCalls[0].args).toContain("--no-compression");
  expect(inputCalls[0].args).not.toContain("--zstd");

  expect(inputCalls[1].args).toContain("--zstd");
  expect(inputCalls[1].args).not.toContain("--no-compression");
}, processTestTimeout);

test("classifies only Bunfig TOML inputs as bunfig cache entries", () => {
  const fixture = setupRepo("bunfig-kind");
  const result = runPowerShell(fixture, [
    "-OutputDir",
    ".dx\\js-bunfig-kind",
    "-NoWorkspacePackages",
    "-Inputs",
    "bunfig.toml,bunfig.node-test.toml,tooling.toml",
  ]);

  expectSuccess(result);

  const indexPath = path.join(fixture.repo, ".dx", "js-bunfig-kind", "index.json");
  const catalogPath = path.join(fixture.repo, ".dx", "js-bunfig-kind", "catalog.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as CacheIndex;
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as CacheCatalog;
  const kindsBySource = Object.fromEntries(index.entries.map((entry) => [entry.source, entry.kind]));

  expect(kindsBySource).toEqual({
    "bunfig.toml": "bunfig",
    "bunfig.node-test.toml": "bunfig",
    "tooling.toml": "structured",
  });
  expect(catalog.entries.map((entry) => entry.key)).toEqual([
    "bunfig\0bunfig.node-test.toml",
    "bunfig\0bunfig.toml",
  ]);
  expect(catalog.entries.some((entry) => entry.kind === "structured")).toBe(false);
  expect(catalog.shards.every((shard) => !shard.startsWith("structured/"))).toBe(true);
}, processTestTimeout);

test("honors NoIndex", () => {
  const fixture = setupRepo("no-index");
  const result = runPowerShell(fixture, ["-OutputDir", ".dx\\js-no-index", "-NoIndex"]);

  expectSuccess(result);
  expect(fs.existsSync(path.join(fixture.repo, ".dx", "js-no-index", "index.json"))).toBe(false);
  expect(fs.existsSync(path.join(fixture.repo, ".dx", "js-no-index", "catalog.json"))).toBe(false);
  expect(fs.existsSync(path.join(fixture.repo, ".dx", "js-no-index", "catalog.machine"))).toBe(false);
  expect(fs.existsSync(path.join(fixture.repo, ".dx", "js-no-index", "shards"))).toBe(false);
}, processTestTimeout);

test("fails when dx-serialize does not create expected metadata", () => {
  const fixture = setupRepo("missing-metadata");
  const result = runPowerShell(
    fixture,
    ["-OutputDir", ".dx\\js-missing", "-NoIndex"],
    { DX_SKIP_META_FOR: "package.json" },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("Expected machine metadata output was not created");
  expect(
    fs.existsSync(path.join(fixture.repo, ".dx", "js-missing", `${jsCacheStem("package.json")}.machine`)),
  ).toBe(true);
}, processTestTimeout);
