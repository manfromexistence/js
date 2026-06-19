import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  findDxJsMachineCacheEntry,
  findPackageJsonCacheEntry,
  loadDxJsMachineCacheIndex,
  readTrustedDxJsMachineCacheEntry,
  readTrustedPackageJsonKeyInterningSidecar,
  scanPackageJsonKeyInterningSidecarContract,
  scanPackageJsonMetadataFallback,
  type DxJsMachineCacheTrustedKind,
  validatePackageJsonCacheEntry,
} from "./dx-js-package-json-cache.ts";

const testRoot = path.join("G:\\dx\\bun\\.tmp", "dx-js-package-json-cache-test");

function mkdirp(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

function writeFile(target: string, contents: string): void {
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, contents);
}

function writeCacheFixture(root: string, source = "packages/pkg/package.json"): void {
  const sourcePath = path.join(root, ...source.split("/"));
  const machine = ".dx/js/packages-pkg-package-json.machine";
  const metadata = ".dx/js/packages-pkg-package-json.machine.meta.json";
  const packageJson = JSON.stringify(
    {
      name: "pkg",
      type: "module",
      scripts: { build: "bun build" },
      exports: "./index.ts",
    },
    null,
    2,
  );

  writeFile(sourcePath, packageJson);
  writeFile(path.join(root, machine), "DXM1fake");
  const stat = fs.statSync(sourcePath);

  writeFile(
    path.join(root, metadata),
    JSON.stringify(
      {
        schema: "dx.machine.source_metadata.v1",
        source: {
          path: source,
          bytes: Buffer.byteLength(packageJson),
          modified_unix_ms: Math.trunc(stat.mtimeMs),
          blake3: "source-hash",
        },
        machine: {
          path: machine,
          bytes: Buffer.byteLength("DXM1fake"),
          blake3: "machine-hash",
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

  writeFile(
    path.join(root, ".dx/js/index.json"),
    JSON.stringify(
      {
        schema: "dx.js.machine_cache_index.v1",
        generatedAtUtc: "2026-05-29T00:00:00.000Z",
        entries: [
          {
            source,
            kind: "package_json",
            stem: "packages-pkg-package-json",
            machine,
            metadata,
            sourceBytes: Buffer.byteLength(packageJson),
            sourceModifiedUnixMs: Math.trunc(stat.mtimeMs),
            sourceBlake3: "source-hash",
            machineBlake3: "machine-hash",
            machineBytes: Buffer.byteLength("DXM1fake"),
            metadataBytes: fs.statSync(path.join(root, metadata)).size,
          },
        ],
      },
      null,
      2,
    ),
  );
}

type GenericCacheFixtureInput = {
  source: string;
  kind: DxJsMachineCacheTrustedKind;
  sourceText: string;
  machineText: string;
};

type GenericCacheFixtureEntry = GenericCacheFixtureInput & {
  machine: string;
  metadata: string;
  sourceBlake3: string;
  machineBlake3: string;
};

function writeGenericCacheFixture(
  root: string,
  inputs: GenericCacheFixtureInput[],
): GenericCacheFixtureEntry[] {
  const entries: GenericCacheFixtureEntry[] = [];

  for (const input of inputs) {
    const stem = input.source.replaceAll(/[\\/]+/g, "-").replaceAll(".", "-");
    const machine = `.dx/js/${stem}.machine`;
    const metadata = `.dx/js/${stem}.machine.meta.json`;
    const sourceBlake3 = `source-${stem}`;
    const machineBlake3 = `machine-${stem}`;

    writeFile(path.join(root, ...input.source.split("/")), input.sourceText);
    writeFile(path.join(root, machine), input.machineText);

    const sourceStat = fs.statSync(path.join(root, ...input.source.split("/")));

    writeFile(
      path.join(root, metadata),
      JSON.stringify(
        {
          schema: "dx.machine.source_metadata.v1",
          source: {
            path: input.source,
            bytes: Buffer.byteLength(input.sourceText),
            modified_unix_ms: Math.trunc(sourceStat.mtimeMs),
            blake3: sourceBlake3,
          },
          machine: {
            path: machine,
            bytes: Buffer.byteLength(input.machineText),
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

    entries.push({ ...input, machine, metadata, sourceBlake3, machineBlake3 });
  }

  writeFile(
    path.join(root, ".dx/js/index.json"),
    JSON.stringify(
      {
        schema: "dx.js.machine_cache_index.v1",
        generatedAtUtc: "2026-05-29T00:00:00.000Z",
        entries: entries.map((entry) => {
          const sourceStat = fs.statSync(path.join(root, ...entry.source.split("/")));
          return {
            source: entry.source,
            kind: entry.kind,
            stem: entry.source.replaceAll(/[\\/]+/g, "-").replaceAll(".", "-"),
            machine: entry.machine,
            metadata: entry.metadata,
            sourceBytes: Buffer.byteLength(entry.sourceText),
            sourceModifiedUnixMs: Math.trunc(sourceStat.mtimeMs),
            sourceBlake3: entry.sourceBlake3,
            machineBlake3: entry.machineBlake3,
            machineBytes: Buffer.byteLength(entry.machineText),
            metadataBytes: fs.statSync(path.join(root, entry.metadata)).size,
          };
        }),
      },
      null,
      2,
    ),
  );

  return entries;
}

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("loads, normalizes, and validates package.json cache entries", async () => {
  const root = path.join(testRoot, "valid");
  fs.rmSync(root, { recursive: true, force: true });
  writeCacheFixture(root);

  const index = await loadDxJsMachineCacheIndex(root);
  const entry = findPackageJsonCacheEntry(index, "packages\\pkg\\package.json");

  expect(entry?.source).toBe("packages/pkg/package.json");
  await expect(
    validatePackageJsonCacheEntry(root, entry!, {
      hashSource: async () => "source-hash",
    }),
  ).resolves.toEqual({ ok: true });
});

test("rejects Windows stat-key collisions before trusting cache entries", async () => {
  const root = path.join(testRoot, "stat-key-collision");
  fs.rmSync(root, { recursive: true, force: true });
  writeFile(
    path.join(root, ".dx/js/index.json"),
    JSON.stringify(
      {
        schema: "dx.js.machine_cache_index.v1",
        generatedAtUtc: "2026-05-29T00:00:00.000Z",
        entries: [
          cacheEntry("Packages/Pkg/package.json", "package_json"),
          cacheEntry("packages/pkg/package.json", "package_json"),
        ],
      },
      null,
      2,
    ),
  );

  await expect(loadDxJsMachineCacheIndex(root)).rejects.toThrow("Duplicate DX JS machine cache stat key");
});

test("rejects Windows stat-key collisions for trusted bunfig cache entries", async () => {
  const root = path.join(testRoot, "bunfig-stat-key-collision");
  fs.rmSync(root, { recursive: true, force: true });
  writeFile(
    path.join(root, ".dx/js/index.json"),
    JSON.stringify(
      {
        schema: "dx.js.machine_cache_index.v1",
        generatedAtUtc: "2026-05-29T00:00:00.000Z",
        entries: [
          cacheEntry("Bunfig.toml", "bunfig"),
          cacheEntry("bunfig.toml", "bunfig"),
        ],
      },
      null,
      2,
    ),
  );

  await expect(loadDxJsMachineCacheIndex(root)).rejects.toThrow("Duplicate DX JS machine cache stat key");
});

test("rejects stale package.json cache entries by source size and hash", async () => {
  const root = path.join(testRoot, "stale");
  fs.rmSync(root, { recursive: true, force: true });
  writeCacheFixture(root);
  const index = await loadDxJsMachineCacheIndex(root);
  const entry = findPackageJsonCacheEntry(index, "packages/pkg/package.json")!;

  writeFile(path.join(root, "packages/pkg/package.json"), "{\"name\":\"pkg\",\"extra\":true}\n");
  const staleBySize = await validatePackageJsonCacheEntry(root, entry, {
    hashSource: async () => "source-hash",
  });
  expect(staleBySize.ok).toBe(false);
  if (staleBySize.ok) {
    throw new Error("source size mismatch validated successfully");
  }
  expect(staleBySize.reason).toBe("source_bytes_mismatch");

  writeCacheFixture(root);
  const freshIndex = await loadDxJsMachineCacheIndex(root);
  const freshEntry = findPackageJsonCacheEntry(freshIndex, "packages/pkg/package.json")!;
  const staleByHash = await validatePackageJsonCacheEntry(root, freshEntry, {
    hashSource: async () => "different-hash",
  });
  expect(staleByHash.ok).toBe(false);
  if (staleByHash.ok) {
    throw new Error("source hash mismatch validated successfully");
  }
  expect(staleByHash.reason).toBe("source_blake3_mismatch");
});

test("rejects package.json cache entries with bad metadata schema", async () => {
  const root = path.join(testRoot, "bad-schema");
  fs.rmSync(root, { recursive: true, force: true });
  writeCacheFixture(root);
  writeFile(
    path.join(root, ".dx/js/packages-pkg-package-json.machine.meta.json"),
    JSON.stringify({ schema: "wrong" }),
  );

  const index = await loadDxJsMachineCacheIndex(root);
  const entry = findPackageJsonCacheEntry(index, "packages/pkg/package.json")!;
  const result = await validatePackageJsonCacheEntry(root, entry);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("bad metadata schema validated successfully");
  }
  expect(result.reason).toBe("metadata_schema_mismatch");
});

test("reads trusted package_json, tsconfig, and bunfig sidecars after validation", async () => {
  const root = path.join(testRoot, "trusted-sidecars");
  fs.rmSync(root, { recursive: true, force: true });
  const fixtures = writeGenericCacheFixture(root, [
    {
      source: "package.json",
      kind: "package_json",
      sourceText: "{\"name\":\"workspace\"}\n",
      machineText: "DXM1:package_json:workspace",
    },
    {
      source: "tsconfig.json",
      kind: "tsconfig",
      sourceText: "{\"compilerOptions\":{\"baseUrl\":\".\"}}\n",
      machineText: "DXM1:tsconfig:paths",
    },
    {
      source: "bunfig.toml",
      kind: "bunfig",
      sourceText: "[install]\nlinker = \"isolated\"\n",
      machineText: "DXM1:bunfig:install",
    },
  ]);

  const index = await loadDxJsMachineCacheIndex(root);

  for (const fixture of fixtures) {
    const entry = findDxJsMachineCacheEntry(index, fixture.kind, fixture.source);
    if (!entry) {
      throw new Error(`missing cache entry for ${fixture.kind}:${fixture.source}`);
    }

    const bytecheckCalls: string[] = [];
    const result = await readTrustedDxJsMachineCacheEntry(root, entry, {
      kind: fixture.kind,
      hashSource: async () => fixture.sourceBlake3,
      hashMachine: async (_machinePath, machineBytes) => {
        expect(Buffer.from(machineBytes).toString()).toBe(fixture.machineText);
        return fixture.machineBlake3;
      },
      bytecheckMachine: async ({ kind, machineBytes }) => {
        bytecheckCalls.push(kind);
        return Buffer.from(machineBytes).toString().startsWith(`DXM1:${kind}:`);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      trusted: true,
      kind: fixture.kind,
      source: fixture.source,
    });
    if (!result.ok) {
      throw new Error(`expected trusted sidecar, got ${result.reason}`);
    }
    expect(result.entry).toBe(entry);
    expect(Buffer.from(result.machineBytes).toString()).toBe(fixture.machineText);
    expect(bytecheckCalls).toEqual([fixture.kind]);
  }
});

test("does not bytecheck or trust sidecars when machine blake3 validation fails", async () => {
  const root = path.join(testRoot, "machine-hash-before-bytecheck");
  fs.rmSync(root, { recursive: true, force: true });
  const [fixture] = writeGenericCacheFixture(root, [
    {
      source: "tsconfig.json",
      kind: "tsconfig",
      sourceText: "{}\n",
      machineText: "DXM1:tsconfig:paths",
    },
  ]);

  const index = await loadDxJsMachineCacheIndex(root);
  const entry = findDxJsMachineCacheEntry(index, fixture.kind, fixture.source);
  let bytecheckCalls = 0;
  const result = await readTrustedDxJsMachineCacheEntry(root, entry, {
    kind: fixture.kind,
    hashSource: async () => fixture.sourceBlake3,
    hashMachine: async () => "different-machine-hash",
    bytecheckMachine: async () => {
      bytecheckCalls++;
      return true;
    },
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("machine hash mismatch returned a trusted sidecar");
  }
  expect(result.reason).toBe("machine_blake3_mismatch");
  expect(bytecheckCalls).toBe(0);
});

test("rejects sidecars that fail bytecheck before returning trusted bytes", async () => {
  const root = path.join(testRoot, "bytecheck-failed");
  fs.rmSync(root, { recursive: true, force: true });
  const [fixture] = writeGenericCacheFixture(root, [
    {
      source: "bunfig.toml",
      kind: "bunfig",
      sourceText: "[install]\n",
      machineText: "DXM1:bunfig:install",
    },
  ]);

  const index = await loadDxJsMachineCacheIndex(root);
  const entry = findDxJsMachineCacheEntry(index, fixture.kind, fixture.source);
  const result = await readTrustedDxJsMachineCacheEntry(root, entry, {
    kind: fixture.kind,
    hashSource: async () => fixture.sourceBlake3,
    hashMachine: async () => fixture.machineBlake3,
    bytecheckMachine: async () => false,
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("bytecheck failure returned a trusted sidecar");
  }
  expect(result.reason).toBe("machine_bytecheck_failed");
});

test("scans package.json metadata fields without matching quoted value text", () => {
  const fields = scanPackageJsonMetadataFallback(
    JSON.stringify({
      description: 'mentions "exports", "imports", and "dependencies" inside a value',
      name: "pkg",
      type: "module",
      scripts: { build: "bun build" },
      exports: "./index.ts",
    }),
  );

  expect(fields).toEqual({
    dependencies: false,
    exports: true,
    imports: false,
    name: true,
    scripts: true,
    type: true,
  });
});

test("builds deterministic package.json key interning sidecar stats", () => {
  const contract = scanPackageJsonKeyInterningSidecarContract(
    JSON.stringify(
      {
        name: "workspace",
        scripts: {
          build: "bun build",
          test: "bun test",
        },
        dependencies: {
          "@types/bun": "latest",
        },
        devDependencies: {
          "@types/bun": "latest",
        },
        overrides: {
          "pkg-a": {
            version: "1.0.0",
          },
          "pkg-b": {
            version: "2.0.0",
          },
        },
        exports: {
          ".": "./index.ts",
          "./cli": "./cli.ts",
        },
      },
      null,
      2,
    ),
  );

  expect(contract).toEqual({
    schema: "dx.package_json.key_interning_sidecar.v1",
    sourceFormat: "package_json",
    keyEncoding: "utf8",
    objectKeyOccurrences: 16,
    uniqueKeys: 14,
    repeatedKeys: 2,
    repeatedKeyOccurrences: 4,
    extraRepeatedKeyOccurrences: 2,
    estimated: {
      originalQuotedKeyBytes: 161,
      internedUniqueQuotedKeyBytes: 138,
      savedQuotedKeyBytes: 23,
    },
    keys: [
      {
        key: ".",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 1,
        quotedKeyBytes: 4,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "./cli",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 5,
        quotedKeyBytes: 8,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "@types/bun",
        occurrences: 2,
        extraOccurrences: 1,
        keyUtf8Bytes: 10,
        quotedKeyBytes: 13,
        estimatedSavedQuotedKeyBytes: 13,
      },
      {
        key: "build",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 5,
        quotedKeyBytes: 8,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "dependencies",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 12,
        quotedKeyBytes: 15,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "devDependencies",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 15,
        quotedKeyBytes: 18,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "exports",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 7,
        quotedKeyBytes: 10,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "name",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 4,
        quotedKeyBytes: 7,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "overrides",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 9,
        quotedKeyBytes: 12,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "pkg-a",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 5,
        quotedKeyBytes: 8,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "pkg-b",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 5,
        quotedKeyBytes: 8,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "scripts",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 7,
        quotedKeyBytes: 10,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "test",
        occurrences: 1,
        extraOccurrences: 0,
        keyUtf8Bytes: 4,
        quotedKeyBytes: 7,
        estimatedSavedQuotedKeyBytes: 0,
      },
      {
        key: "version",
        occurrences: 2,
        extraOccurrences: 1,
        keyUtf8Bytes: 7,
        quotedKeyBytes: 10,
        estimatedSavedQuotedKeyBytes: 10,
      },
    ],
  });
});

test("package.json key interning scanner ignores quoted value text that looks like keys", () => {
  const contract = scanPackageJsonKeyInterningSidecarContract(
    JSON.stringify({
      name: "value mentions \"dependencies\": and \"version\": without object keys",
      description: JSON.stringify({ dependencies: "not a key in this document" }),
      scripts: {
        test: "echo \"name\": \"still a value\"",
      },
    }),
  );

  expect(contract.objectKeyOccurrences).toBe(4);
  expect(contract.uniqueKeys).toBe(4);
  expect(contract.repeatedKeys).toBe(0);
  expect(contract.keys.map((entry) => entry.key)).toEqual(["description", "name", "scripts", "test"]);
});

test("reads trusted package.json key interning sidecars after canonical validation", async () => {
  const root = path.join(testRoot, "trusted-key-interning");
  fs.rmSync(root, { recursive: true, force: true });
  writeCacheFixture(root);

  const index = await loadDxJsMachineCacheIndex(root);
  const entry = findPackageJsonCacheEntry(index, "packages/pkg/package.json")!;
  const keyInterning = ".dx/js/packages-pkg-package-json.keys.json";
  const sidecar = scanPackageJsonKeyInterningSidecarContract(
    JSON.stringify({
      name: "pkg",
      scripts: { build: "bun build", test: "bun test" },
      dependencies: { leftpad: "1.0.0" },
      devDependencies: { leftpad: "1.0.0" },
    }),
  );
  const sidecarText = JSON.stringify(sidecar, null, 2);
  writeFile(path.join(root, keyInterning), sidecarText);

  const result = await readTrustedPackageJsonKeyInterningSidecar(root, { ...entry, keyInterning });

  expect(result).toMatchObject({
    ok: true,
    trusted: true,
    keyInterning,
  });
  if (!result.ok) {
    throw new Error(`expected trusted key interning sidecar, got ${result.reason}`);
  }
  expect(result.sidecarBytes).toBe(Buffer.byteLength(sidecarText));
  expect(result.sidecar).toEqual(sidecar);
  expect(result.sidecar.keys.map((item) => item.key)).toEqual([
    "build",
    "dependencies",
    "devDependencies",
    "leftpad",
    "name",
    "scripts",
    "test",
  ]);
});

test("rejects malformed package.json key interning sidecars before trusting them", async () => {
  const root = path.join(testRoot, "bad-key-interning");
  fs.rmSync(root, { recursive: true, force: true });
  writeCacheFixture(root);

  const index = await loadDxJsMachineCacheIndex(root);
  const entry = findPackageJsonCacheEntry(index, "packages/pkg/package.json")!;
  const keyInterning = ".dx/js/packages-pkg-package-json.keys.json";
  const sidecar = scanPackageJsonKeyInterningSidecarContract(
    JSON.stringify({
      a: 1,
      b: { a: 2 },
    }),
  );

  const badTotals = { ...sidecar, uniqueKeys: sidecar.uniqueKeys + 1 };
  writeFile(path.join(root, keyInterning), JSON.stringify(badTotals));
  const totalsResult = await readTrustedPackageJsonKeyInterningSidecar(root, { ...entry, keyInterning });
  expect(totalsResult.ok).toBe(false);
  if (totalsResult.ok) {
    throw new Error("mismatched key interning totals returned a trusted sidecar");
  }
  expect(totalsResult.reason).toBe("key_interning_totals_mismatch");

  const nonCanonical = { ...sidecar, keys: [...sidecar.keys].reverse() };
  writeFile(path.join(root, keyInterning), JSON.stringify(nonCanonical));
  const canonicalResult = await readTrustedPackageJsonKeyInterningSidecar(root, { ...entry, keyInterning });
  expect(canonicalResult.ok).toBe(false);
  if (canonicalResult.ok) {
    throw new Error("noncanonical key interning keys returned a trusted sidecar");
  }
  expect(canonicalResult.reason).toBe("key_interning_keys_not_canonical");

  const invalidPathResult = await readTrustedPackageJsonKeyInterningSidecar(root, {
    ...entry,
    keyInterning: "../outside.keys.json",
  });
  expect(invalidPathResult.ok).toBe(false);
  if (invalidPathResult.ok) {
    throw new Error("invalid key interning path returned a trusted sidecar");
  }
  expect(invalidPathResult.reason).toBe("invalid_key_interning_path");
});

function cacheEntry(source: string, kind: string) {
  const stem = source.replaceAll(/[\\/]/g, "-");

  return {
    source,
    kind,
    stem,
    machine: `.dx/js/${stem}.machine`,
    metadata: `.dx/js/${stem}.machine.meta.json`,
    sourceBytes: 1,
    sourceModifiedUnixMs: 1,
    sourceBlake3: "source-hash",
    machineBlake3: "machine-hash",
    machineBytes: 1,
    metadataBytes: 1,
  };
}
