import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildDxJsMachineCacheBinaryCatalogContract,
  buildDxJsMachineCacheCatalog,
  buildDxJsMachineCachePackedShardHeaderContract,
  validateDxJsMachineCacheBinaryCatalogContract,
  validateDxJsMachineCachePackedShardHeaderContract,
} from "./dx-js-machine-cache-index-contract.ts";
import type { DxJsMachineCacheIndex } from "./dx-js-package-json-cache.ts";

test("builds a deterministic catalog with normalized cache keys and shards", () => {
  const catalog = buildDxJsMachineCacheCatalog({
    schema: "dx.js.machine_cache_index.v1",
    generatedAtUtc: "2026-05-29T00:00:00.000Z",
    entries: [
      cacheEntry("packages\\pkg\\package.json", "package_json", "BBAA", {
        keyInterning: ".dx\\js\\packages-pkg-package.keys.json",
      }),
      cacheEntry("tsconfig.json", "tsconfig", "AA00"),
    ],
  });

  expect(catalog.schema).toBe("dx.js.machine_cache_catalog.v1");
  expect(catalog.entries.map(entry => entry.key)).toEqual([
    "package_json\0packages/pkg/package.json",
    "tsconfig\0tsconfig.json",
  ]);
  expect(catalog.entries.map(entry => entry.shard)).toEqual([
    expect.stringMatching(/^package_json\/[0-9a-f]{16}$/),
    expect.stringMatching(/^tsconfig\/[0-9a-f]{16}$/),
  ]);
  expect(catalog.entries[0].keyInterning).toBe(".dx/js/packages-pkg-package.keys.json");
  expect(catalog.shards).toEqual([...catalog.entries.map(entry => entry.shard)].sort());
  expect(catalog.entries[0]).toMatchObject({
    sourceBytes: 1,
    sourceModifiedUnixMs: 1,
    machineBlake3: "machine",
    machineBytes: 1,
    metadataBytes: 1,
  });
});

test("describes the rkyv hashbrown catalog.machine contract beside catalog.json", () => {
  const catalog = buildDxJsMachineCacheCatalog({
    schema: "dx.js.machine_cache_index.v1",
    generatedAtUtc: "2026-05-29T00:00:00.000Z",
    entries: [
      cacheEntry("tsconfig.json", "tsconfig", "AA00"),
      cacheEntry("package.json", "package_json", "BBAA", {
        keyInterning: ".dx/js/package-json.keys.json",
      }),
    ],
  });

  const contract = buildDxJsMachineCacheBinaryCatalogContract(catalog, ".dx/js/catalog.json");
  const packageShard = catalog.entries.find(entry => entry.kind === "package_json")!.shard;
  const tsconfigShard = catalog.entries.find(entry => entry.kind === "tsconfig")!.shard;

  expect(contract).toEqual({
    schema: "dx.js.machine_cache_binary_catalog_contract.v1",
    catalogJsonPath: ".dx/js/catalog.json",
    catalogMachinePath: ".dx/js/catalog.machine",
    machineSchema: "dx.js.machine_cache_catalog.machine.rkyv_hashbrown.v1",
    serializer: "rkyv",
    writer: "rust_required",
    lookup: {
      map: "hashbrown",
      keyEncoding: "utf8(kind) + nul + utf8(source)",
      entryOrder: "ascending_key",
      deterministicHasherRequired: true,
    },
    shards: [packageShard, tsconfigShard].sort(),
    entries: [
      {
        key: "package_json\0package.json",
        shard: packageShard,
        machine: ".dx/js/package.json.machine",
        metadata: ".dx/js/package.json.machine.meta.json",
        keyInterning: ".dx/js/package-json.keys.json",
        sourceBlake3: "BBAA",
        machineBlake3: "machine",
        sourceBytes: 1,
        sourceModifiedUnixMs: 1,
        machineBytes: 1,
        metadataBytes: 1,
      },
      {
        key: "tsconfig\0tsconfig.json",
        shard: tsconfigShard,
        machine: ".dx/js/tsconfig.json.machine",
        metadata: ".dx/js/tsconfig.json.machine.meta.json",
        sourceBlake3: "AA00",
        machineBlake3: "machine",
        sourceBytes: 1,
        sourceModifiedUnixMs: 1,
        machineBytes: 1,
        metadataBytes: 1,
      },
    ],
  });
  expect(validateDxJsMachineCacheBinaryCatalogContract(catalog, contract)).toEqual({ ok: true });
});

test("describes packed shard headers from deterministic catalog metadata", () => {
  const catalog = buildDxJsMachineCacheCatalog({
    schema: "dx.js.machine_cache_index.v1",
    generatedAtUtc: "2026-05-29T00:00:00.000Z",
    entries: [
      cacheEntry("packages/a/package.json", "package_json", "BBAA", {
        machineBlake3: "machine-a",
        keyInterning: ".dx/js/packages-a-package.keys.json",
        sourceBytes: 10,
        machineBytes: 20,
        metadataBytes: 2,
      }),
      cacheEntry("packages/b/package.json", "package_json", "BBCC", {
        machineBlake3: "machine-b",
        sourceBytes: 11,
        machineBytes: 21,
        metadataBytes: 3,
      }),
      cacheEntry("tsconfig.json", "tsconfig", "AA00", {
        machineBlake3: "machine-c",
        sourceBytes: 12,
        machineBytes: 22,
        metadataBytes: 4,
      }),
    ],
  });

  const contract = buildDxJsMachineCachePackedShardHeaderContract(catalog, ".dx\\js\\shards");
  const packageShard = catalog.entries.find(entry => entry.kind === "package_json")!.shard;
  const tsconfigShard = catalog.entries.find(entry => entry.kind === "tsconfig")!.shard;

  expect(catalog.entries.map(entry => entry.key)).toEqual([
    "package_json\0packages/a/package.json",
    "package_json\0packages/b/package.json",
    "tsconfig\0tsconfig.json",
  ]);
  expect(contract).toEqual({
    schema: "dx.js.machine_cache_packed_shard_header_contract.v1",
    shardStoreRoot: ".dx/js/shards",
    layout: {
      name: "DxJsMachineCachePackedShardHeader",
      representation: "repr(C) reader / repr(C, packed) writer",
      byteOrder: "little_endian",
      magic: "DXJSHARD",
      version: 4,
      headerBytes: 160,
      bytemuck: ["Pod", "Zeroable"],
      zerocopy: ["FromBytes", "IntoBytes", "KnownLayout", "Immutable"],
      fields: [
        { name: "magic", type: "[u8; 8]", offset: 0, bytes: 8 },
        { name: "version", type: "u32", offset: 8, bytes: 4 },
        { name: "header_bytes", type: "u32", offset: 12, bytes: 4 },
        { name: "kind_id", type: "u32", offset: 16, bytes: 4 },
        { name: "entry_count", type: "u32", offset: 20, bytes: 4 },
        { name: "source_bytes", type: "u64", offset: 24, bytes: 8 },
        { name: "machine_bytes", type: "u64", offset: 32, bytes: 8 },
        { name: "metadata_bytes", type: "u64", offset: 40, bytes: 8 },
        { name: "shard_path_blake3", type: "[u8; 32]", offset: 48, bytes: 32 },
        { name: "source_identity_blake3", type: "[u8; 32]", offset: 80, bytes: 32 },
        { name: "machine_identity_blake3", type: "[u8; 32]", offset: 112, bytes: 32 },
        { name: "reserved", type: "[u8; 16]", offset: 144, bytes: 16 },
      ],
    },
    headers: [
      {
        magic: "DXJSHARD",
        version: 4,
        headerBytes: 160,
        shard: packageShard,
        shardPath: `.dx/js/shards/${packageShard}.dxjs`,
        kind: "package_json",
        kindId: 1,
        entryCount: 2,
        sourceBytes: 21,
        machineBytes: 41,
        metadataBytes: 5,
        identity: {
          algorithm: "blake3",
          contentIdAlgorithm: "sha256(first_16_lower_hex)",
          sourceBlake3: ["BBAA", "BBCC"],
          machineBlake3: ["machine-a", "machine-b"],
          packageJsonReadIdentity: ["serializer-computed-or-none", "serializer-computed-or-none"],
          sourceInputEncoding:
            "utf8(key) + nul + utf8(source_blake3) + nul + utf8(machine_blake3) + nul + utf8(package_json_read_identity_or_none)",
          machineInputEncoding: "utf8(machine:) + source_identity_input",
        },
        entries: [
          {
            key: "package_json\0packages/a/package.json",
            source: "packages/a/package.json",
            machine: ".dx/js/packages-a-package.json.machine",
            metadata: ".dx/js/packages-a-package.json.machine.meta.json",
            keyInterning: ".dx/js/packages-a-package.keys.json",
            sourceBlake3: "BBAA",
            machineBlake3: "machine-a",
          },
          {
            key: "package_json\0packages/b/package.json",
            source: "packages/b/package.json",
            machine: ".dx/js/packages-b-package.json.machine",
            metadata: ".dx/js/packages-b-package.json.machine.meta.json",
            sourceBlake3: "BBCC",
            machineBlake3: "machine-b",
          },
        ],
      },
      {
        magic: "DXJSHARD",
        version: 4,
        headerBytes: 160,
        shard: tsconfigShard,
        shardPath: `.dx/js/shards/${tsconfigShard}.dxjs`,
        kind: "tsconfig",
        kindId: 2,
        entryCount: 1,
        sourceBytes: 12,
        machineBytes: 22,
        metadataBytes: 4,
        identity: {
          algorithm: "blake3",
          contentIdAlgorithm: "sha256(first_16_lower_hex)",
          sourceBlake3: ["AA00"],
          machineBlake3: ["machine-c"],
          packageJsonReadIdentity: ["none"],
          sourceInputEncoding:
            "utf8(key) + nul + utf8(source_blake3) + nul + utf8(machine_blake3) + nul + utf8(package_json_read_identity_or_none)",
          machineInputEncoding: "utf8(machine:) + source_identity_input",
        },
        entries: [
          {
            key: "tsconfig\0tsconfig.json",
            source: "tsconfig.json",
            machine: ".dx/js/tsconfig.json.machine",
            metadata: ".dx/js/tsconfig.json.machine.meta.json",
            sourceBlake3: "AA00",
            machineBlake3: "machine-c",
          },
        ],
      },
    ],
  });
  expect(validateDxJsMachineCachePackedShardHeaderContract(catalog, contract)).toEqual({ ok: true });
});

test("rejects duplicate entries after path normalization", () => {
  expect(() =>
    buildDxJsMachineCacheCatalog({
      schema: "dx.js.machine_cache_index.v1",
      generatedAtUtc: "2026-05-29T00:00:00.000Z",
      entries: [
        cacheEntry("packages/pkg/package.json", "package_json", "aa"),
        cacheEntry("packages\\pkg\\package.json", "package_json", "bb"),
      ],
    }),
  ).toThrow("Duplicate DX JS machine cache catalog key");
});

test("rejects unsafe catalog paths and entries without source hashes", () => {
  expect(() =>
    buildDxJsMachineCacheCatalog({
      schema: "dx.js.machine_cache_index.v1",
      generatedAtUtc: "2026-05-29T00:00:00.000Z",
      entries: [cacheEntry("G:\\dx\\bun\\package.json", "package_json", "aa")],
    }),
  ).toThrow("repo-relative");

  expect(() =>
    buildDxJsMachineCacheCatalog({
      schema: "dx.js.machine_cache_index.v1",
      generatedAtUtc: "2026-05-29T00:00:00.000Z",
      entries: [cacheEntry("package.json", "package_json", "")],
    }),
  ).toThrow("source hash");
});

test("keeps Bun-side trusted machine document adapter wired to the DXM1 package-json bridge", () => {
  const reader = readFileSync(new URL("../src/resolver/dx_machine_cache.rs", import.meta.url), "utf8");

  expect(reader).toContain('const MACHINE_ENVELOPE_MAGIC: [u8; 4] = *b"DXM1";');
  expect(reader).toContain("struct DxMachineDocument");
  expect(reader).toContain("pub struct TrustedMachineDocument");
  expect(reader).toContain("pub fn package_json_summary(&self) -> PackageJsonMachineSummary<'_>");
  expect(reader).toContain("pub fn tsconfig_summary(&self) -> TsconfigMachineSummary<'_>");
  expect(reader).toContain("pub fn bunfig_summary(&self) -> BunfigMachineSummary<'_>");
  expect(reader).toContain("paths_pattern_count");
  expect(reader).toContain("install_scopes_count");
  expect(reader).toContain("rkyv::access::<ArchivedDxMachineDocument, rkyv::rancor::Error>(payload)");
  expect(reader).toContain("rkyv::access_unchecked::<ArchivedDxMachineDocument>(self.payload())");
  expect(reader).toContain("blake3::hash(payload).as_bytes()");
  expect(reader).toContain("compressed machine envelope requires serializer fallback");
});

test("keeps Bun-side catalog and packed shard trust boundaries hardened", () => {
  const reader = readFileSync(new URL("../src/resolver/dx_machine_cache.rs", import.meta.url), "utf8");

  expect(reader).toContain("validate_catalog(path, catalog)?;");
  expect(reader).toContain(".binary_search_by(|lookup| {");
  expect(reader).toContain("compare_lookup_key(lookup.key.as_str(), kind.as_str(), source)");
  expect(reader).toContain("fn compare_lookup_key(lookup_key: &str, kind: &str, source: &str) -> std::cmp::Ordering");
  expect(reader).toContain("virtual_cache_key_byte(kind.as_bytes(), source.as_bytes(), index)");
  expect(reader).not.toContain("let key = cache_key(kind.as_str(), source);");
  expect(reader).toContain("validate_packed_shard(path, header, shard)?;");
  expect(reader).toContain("catalog lookup index out of range");
  expect(reader).toContain("catalog shards do not match entries");
  expect(reader).toContain("catalog entry shard content id mismatch");
  expect(reader).toContain("catalog entry path is not repo-relative");
  expect(reader).toContain("catalog entry key interning path is not repo-relative");
  expect(reader).toContain("fn trust_package_json_snapshot_enabled() -> bool");
  expect(reader).toContain("if !trust_package_json_snapshot {");
  expect(reader).toContain("packed shard entry count mismatch");
  expect(reader).toContain("packed shard key interning path is not repo-relative");
  expect(reader).toContain("packed shard source identity mismatch");
  expect(reader).toContain("packed shard machine identity mismatch");
  expect(reader).toContain("packed_shard_path_identity_input(shard.shard.as_str())");
  expect(reader).toContain("fn is_safe_repo_relative_path(value: &str) -> bool");
  expect(reader).toContain("value.contains(':')");
  expect(reader).toContain("fn is_lower_hex_64(value: &str) -> bool");
});

function cacheEntry(
  source: string,
  kind: string,
  sourceBlake3: string,
  overrides: Partial<DxJsMachineCacheIndex["entries"][number]> = {},
): DxJsMachineCacheIndex["entries"][number] {
  const stem = source.replaceAll(/[\\/]/g, "-");

  return {
    source,
    kind,
    stem,
    machine: `.dx/js/${stem}.machine`,
    metadata: `.dx/js/${stem}.machine.meta.json`,
    sourceBytes: 1,
    sourceModifiedUnixMs: 1,
    sourceBlake3,
    machineBlake3: "machine",
    machineBytes: 1,
    metadataBytes: 1,
    ...overrides,
  };
}
