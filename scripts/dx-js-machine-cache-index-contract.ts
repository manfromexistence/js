import { createHash } from "node:crypto";
import { normalizeDxCachePath } from "./dx-js-cache-path-contract.ts";
import type { DxJsMachineCacheEntry, DxJsMachineCacheIndex } from "./dx-js-package-json-cache.ts";

export type DxJsMachineCacheCatalogEntry = {
  key: string;
  kind: string;
  source: string;
  shard: string;
  machine: string;
  metadata: string;
  keyInterning?: string;
  sourceBytes: number;
  sourceModifiedUnixMs: number | null;
  sourceBlake3: string;
  machineBlake3: string;
  machineBytes: number;
  metadataBytes: number;
};

export type DxJsMachineCacheCatalog = {
  schema: "dx.js.machine_cache_catalog.v1";
  generatedAtUtc: string;
  shards: string[];
  entries: DxJsMachineCacheCatalogEntry[];
};

export type DxJsMachineCacheBinaryCatalogContractEntry = Pick<
  DxJsMachineCacheCatalogEntry,
  | "key"
  | "shard"
  | "machine"
  | "metadata"
  | "keyInterning"
  | "sourceBytes"
  | "sourceModifiedUnixMs"
  | "sourceBlake3"
  | "machineBlake3"
  | "machineBytes"
  | "metadataBytes"
>;

export type DxJsMachineCacheBinaryCatalogContract = {
  schema: "dx.js.machine_cache_binary_catalog_contract.v1";
  catalogJsonPath: string;
  catalogMachinePath: string;
  machineSchema: "dx.js.machine_cache_catalog.machine.rkyv_hashbrown.v1";
  serializer: "rkyv";
  writer: "rust_required";
  lookup: {
    map: "hashbrown";
    keyEncoding: "utf8(kind) + nul + utf8(source)";
    entryOrder: "ascending_key";
    deterministicHasherRequired: true;
  };
  shards: string[];
  entries: DxJsMachineCacheBinaryCatalogContractEntry[];
};

export type DxJsMachineCacheBinaryCatalogContractValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_catalog"
        | "schema_mismatch"
        | "catalog_json_path_mismatch"
        | "catalog_machine_path_mismatch"
        | "machine_schema_mismatch"
        | "serializer_mismatch"
        | "writer_mismatch"
        | "lookup_mismatch"
        | "shards_mismatch"
        | "entries_mismatch";
      message: string;
    };

export type DxJsMachineCachePackedShardHeaderLayoutField = {
  name:
    | "magic"
    | "version"
    | "header_bytes"
    | "kind_id"
    | "entry_count"
    | "source_bytes"
    | "machine_bytes"
    | "metadata_bytes"
    | "shard_path_blake3"
    | "source_identity_blake3"
    | "machine_identity_blake3"
    | "reserved";
  type: "[u8; 8]" | "u32" | "u64" | "[u8; 32]" | "[u8; 16]";
  offset: number;
  bytes: number;
};

export type DxJsMachineCachePackedShardHeaderLayout = {
  name: "DxJsMachineCachePackedShardHeader";
  representation: "repr(C) reader / repr(C, packed) writer";
  byteOrder: "little_endian";
  magic: "DXJSHARD";
  version: 4;
  headerBytes: 160;
  bytemuck: ["Pod", "Zeroable"];
  zerocopy: ["FromBytes", "IntoBytes", "KnownLayout", "Immutable"];
  fields: DxJsMachineCachePackedShardHeaderLayoutField[];
};

export type DxJsMachineCachePackedShardHeaderEntry = Pick<
  DxJsMachineCacheCatalogEntry,
  "key" | "source" | "machine" | "metadata" | "sourceBlake3" | "machineBlake3"
  | "keyInterning"
>;

export type DxJsMachineCachePackedShardHeaderIdentity = {
  algorithm: "blake3";
  contentIdAlgorithm: "sha256(first_16_lower_hex)";
  sourceBlake3: string[];
  machineBlake3: string[];
  packageJsonReadIdentity: string[];
  sourceInputEncoding: "utf8(key) + nul + utf8(source_blake3) + nul + utf8(machine_blake3) + nul + utf8(package_json_read_identity_or_none)";
  machineInputEncoding: "utf8(machine:) + source_identity_input";
};

export type DxJsMachineCachePackedShardHeader = {
  magic: "DXJSHARD";
  version: 4;
  headerBytes: 160;
  shard: string;
  shardPath: string;
  kind: string;
  kindId: number;
  entryCount: number;
  sourceBytes: number;
  machineBytes: number;
  metadataBytes: number;
  identity: DxJsMachineCachePackedShardHeaderIdentity;
  entries: DxJsMachineCachePackedShardHeaderEntry[];
};

export type DxJsMachineCachePackedShardHeaderContract = {
  schema: "dx.js.machine_cache_packed_shard_header_contract.v1";
  shardStoreRoot: string;
  layout: DxJsMachineCachePackedShardHeaderLayout;
  headers: DxJsMachineCachePackedShardHeader[];
};

export type DxJsMachineCachePackedShardHeaderContractValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_catalog"
        | "schema_mismatch"
        | "shard_store_root_mismatch"
        | "layout_mismatch"
        | "headers_mismatch";
      message: string;
    };

const catalogSchema = "dx.js.machine_cache_catalog.v1";
const binaryCatalogContractSchema = "dx.js.machine_cache_binary_catalog_contract.v1";
const binaryCatalogMachineSchema = "dx.js.machine_cache_catalog.machine.rkyv_hashbrown.v1";
const packedShardHeaderContractSchema = "dx.js.machine_cache_packed_shard_header_contract.v1";
const packedShardHeaderMagic = "DXJSHARD";
const packedShardHeaderVersion = 4;
const packedShardHeaderBytes = 160;
const packedShardHeaderSourceIdentityInputEncoding =
  "utf8(key) + nul + utf8(source_blake3) + nul + utf8(machine_blake3) + nul + utf8(package_json_read_identity_or_none)";
const packedShardHeaderMachineIdentityInputEncoding = "utf8(machine:) + source_identity_input";
const packedShardContentIdAlgorithm = "sha256(first_16_lower_hex)";
const packedShardKindIds: Record<string, number> = {
  package_json: 1,
  tsconfig: 2,
  bunfig: 3,
};
const packedShardHeaderLayout: DxJsMachineCachePackedShardHeaderLayout = {
  name: "DxJsMachineCachePackedShardHeader",
  representation: "repr(C) reader / repr(C, packed) writer",
  byteOrder: "little_endian",
  magic: packedShardHeaderMagic,
  version: packedShardHeaderVersion,
  headerBytes: packedShardHeaderBytes,
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
};

export function buildDxJsMachineCacheCatalog(index: DxJsMachineCacheIndex): DxJsMachineCacheCatalog {
  const seen = new Set<string>();
  const entries = index.entries
    .map(entry => toCatalogEntry(entry))
    .sort((left, right) => compareOrdinal(left.key, right.key));

  for (const entry of entries) {
    if (seen.has(entry.key)) {
      throw new Error(`Duplicate DX JS machine cache catalog key: ${entry.key}`);
    }
    seen.add(entry.key);
  }
  applyImmutableShardIds(entries);

  return {
    schema: catalogSchema,
    generatedAtUtc: index.generatedAtUtc,
    shards: [...new Set(entries.map(entry => entry.shard))].sort(compareOrdinal),
    entries,
  };
}

export function buildDxJsMachineCacheBinaryCatalogContract(
  catalog: DxJsMachineCacheCatalog,
  catalogJsonPath = ".dx/js/catalog.json",
): DxJsMachineCacheBinaryCatalogContract {
  assertCanonicalCatalog(catalog);

  const normalizedCatalogJsonPath = normalizeDxCachePath(catalogJsonPath);

  return {
    schema: binaryCatalogContractSchema,
    catalogJsonPath: normalizedCatalogJsonPath,
    catalogMachinePath: getDxJsMachineCacheCatalogMachinePath(normalizedCatalogJsonPath),
    machineSchema: binaryCatalogMachineSchema,
    serializer: "rkyv",
    writer: "rust_required",
    lookup: {
      map: "hashbrown",
      keyEncoding: "utf8(kind) + nul + utf8(source)",
      entryOrder: "ascending_key",
      deterministicHasherRequired: true,
    },
    shards: [...catalog.shards],
    entries: catalog.entries.map(toBinaryCatalogContractEntry),
  };
}

export function validateDxJsMachineCacheBinaryCatalogContract(
  catalog: DxJsMachineCacheCatalog,
  contract: DxJsMachineCacheBinaryCatalogContract,
): DxJsMachineCacheBinaryCatalogContractValidation {
  let expected: DxJsMachineCacheBinaryCatalogContract;
  try {
    expected = buildDxJsMachineCacheBinaryCatalogContract(catalog, contract.catalogJsonPath);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_catalog",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (contract.schema !== expected.schema) {
    return mismatch("schema_mismatch", `Unexpected DX JS binary catalog contract schema: ${contract.schema}`);
  }
  if (contract.catalogJsonPath !== expected.catalogJsonPath) {
    return mismatch("catalog_json_path_mismatch", "DX JS binary catalog JSON path must be normalized");
  }
  if (contract.catalogMachinePath !== expected.catalogMachinePath) {
    return mismatch("catalog_machine_path_mismatch", "DX JS binary catalog machine path must sit beside catalog.json");
  }
  if (contract.machineSchema !== expected.machineSchema) {
    return mismatch(
      "machine_schema_mismatch",
      `Unexpected DX JS binary catalog machine schema: ${contract.machineSchema}`,
    );
  }
  if (contract.serializer !== expected.serializer) {
    return mismatch("serializer_mismatch", "DX JS binary catalog serializer must be rkyv");
  }
  if (contract.writer !== expected.writer) {
    return mismatch("writer_mismatch", "DX JS binary catalog writer must be the Rust generator");
  }
  if (JSON.stringify(contract.lookup) !== JSON.stringify(expected.lookup)) {
    return mismatch("lookup_mismatch", "DX JS binary catalog lookup contract must use deterministic hashbrown keys");
  }
  if (JSON.stringify(contract.shards) !== JSON.stringify(expected.shards)) {
    return mismatch("shards_mismatch", "DX JS binary catalog shards must match the JSON catalog");
  }
  if (JSON.stringify(contract.entries) !== JSON.stringify(expected.entries)) {
    return mismatch("entries_mismatch", "DX JS binary catalog entries must match the JSON catalog");
  }

  return { ok: true };
}

export function buildDxJsMachineCachePackedShardHeaderContract(
  catalog: DxJsMachineCacheCatalog,
  shardStoreRoot = ".dx/js/shards",
): DxJsMachineCachePackedShardHeaderContract {
  assertCanonicalCatalog(catalog);

  const normalizedShardStoreRoot = normalizeDxCachePath(shardStoreRoot);

  return {
    schema: packedShardHeaderContractSchema,
    shardStoreRoot: normalizedShardStoreRoot,
    layout: clonePackedShardHeaderLayout(),
    headers: catalog.shards.map(shard =>
      buildDxJsMachineCachePackedShardHeader(
        shard,
        normalizedShardStoreRoot,
        catalog.entries.filter(entry => entry.shard === shard),
      ),
    ),
  };
}

export function validateDxJsMachineCachePackedShardHeaderContract(
  catalog: DxJsMachineCacheCatalog,
  contract: DxJsMachineCachePackedShardHeaderContract,
): DxJsMachineCachePackedShardHeaderContractValidation {
  let expected: DxJsMachineCachePackedShardHeaderContract;
  try {
    expected = buildDxJsMachineCachePackedShardHeaderContract(catalog, contract.shardStoreRoot);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_catalog",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (contract.schema !== expected.schema) {
    return packedShardHeaderMismatch(
      "schema_mismatch",
      `Unexpected DX JS packed shard header schema: ${contract.schema}`,
    );
  }
  if (contract.shardStoreRoot !== expected.shardStoreRoot) {
    return packedShardHeaderMismatch("shard_store_root_mismatch", "DX JS packed shard root path must be normalized");
  }
  if (JSON.stringify(contract.layout) !== JSON.stringify(expected.layout)) {
    return packedShardHeaderMismatch(
      "layout_mismatch",
      "DX JS packed shard header layout must match the bytemuck/zerocopy contract",
    );
  }
  if (JSON.stringify(contract.headers) !== JSON.stringify(expected.headers)) {
    return packedShardHeaderMismatch(
      "headers_mismatch",
      "DX JS packed shard headers must match the canonical catalog shards",
    );
  }

  return { ok: true };
}

function toCatalogEntry(entry: DxJsMachineCacheEntry): DxJsMachineCacheCatalogEntry {
  if (!entry.sourceBlake3) {
    throw new Error(`DX JS machine cache catalog entry is missing source hash: ${entry.source}`);
  }
  if (!entry.machineBlake3) {
    throw new Error(`DX JS machine cache catalog entry is missing machine hash: ${entry.machine}`);
  }

  const source = normalizeDxCachePath(entry.source);
  const kind = entry.kind.trim();

  if (!kind) {
    throw new Error(`DX JS machine cache catalog entry is missing kind: ${entry.source}`);
  }
  assertNonNegativeInteger(entry.sourceBytes, "source bytes", entry.source);
  assertNullableNonNegativeInteger(entry.sourceModifiedUnixMs, "source modified time", entry.source);
  assertNonNegativeInteger(entry.machineBytes, "machine bytes", entry.machine);
  assertNonNegativeInteger(entry.metadataBytes, "metadata bytes", entry.metadata);

  return {
    key: `${kind}\0${source}`,
    kind,
    source,
    shard: kind,
    machine: normalizeDxCachePath(entry.machine),
    metadata: normalizeDxCachePath(entry.metadata),
    keyInterning: normalizeOptionalDxCachePath(entry.keyInterning),
    sourceBytes: entry.sourceBytes,
    sourceModifiedUnixMs: entry.sourceModifiedUnixMs,
    sourceBlake3: entry.sourceBlake3,
    machineBlake3: entry.machineBlake3,
    machineBytes: entry.machineBytes,
    metadataBytes: entry.metadataBytes,
  };
}

function applyImmutableShardIds(entries: DxJsMachineCacheCatalogEntry[]): void {
  const groups = new Map<string, DxJsMachineCacheCatalogEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.shard);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.shard, [entry]);
    }
  }

  for (const [baseShard, group] of groups) {
    const contentId = shardContentId(group);
    for (const entry of group) {
      entry.shard = `${baseShard}/${contentId}`;
    }
  }
}

function shardContentId(entries: DxJsMachineCacheCatalogEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => compareOrdinal(left.key, right.key))) {
    hash.update(entry.key);
    hash.update("\0");
    hash.update(entry.sourceBlake3);
    hash.update("\0");
    hash.update(entry.machineBlake3);
    hash.update("\0");
  }

  return hash.digest("hex").slice(0, 16);
}

function toBinaryCatalogContractEntry(entry: DxJsMachineCacheCatalogEntry): DxJsMachineCacheBinaryCatalogContractEntry {
  const contractEntry: DxJsMachineCacheBinaryCatalogContractEntry = {
    key: entry.key,
    shard: entry.shard,
    machine: entry.machine,
    metadata: entry.metadata,
    sourceBytes: entry.sourceBytes,
    sourceModifiedUnixMs: entry.sourceModifiedUnixMs,
    sourceBlake3: entry.sourceBlake3,
    machineBlake3: entry.machineBlake3,
    machineBytes: entry.machineBytes,
    metadataBytes: entry.metadataBytes,
  };
  if (entry.keyInterning) {
    contractEntry.keyInterning = entry.keyInterning;
  }
  return contractEntry;
}

function getDxJsMachineCacheCatalogMachinePath(catalogJsonPath: string): string {
  const parts = normalizeDxCachePath(catalogJsonPath).split("/");
  if (parts.at(-1) !== "catalog.json") {
    throw new Error(`DX JS machine cache binary catalog path must end with catalog.json: ${catalogJsonPath}`);
  }

  parts[parts.length - 1] = "catalog.machine";
  return parts.join("/");
}

function buildDxJsMachineCachePackedShardHeader(
  shard: string,
  shardStoreRoot: string,
  entries: DxJsMachineCacheCatalogEntry[],
): DxJsMachineCachePackedShardHeader {
  if (entries.length === 0) {
    throw new Error(`DX JS packed shard header has no catalog entries: ${shard}`);
  }

  const kind = entries[0].kind;
  if (entries.some(entry => entry.kind !== kind)) {
    throw new Error(`DX JS packed shard header cannot mix entry kinds: ${shard}`);
  }
  assertU32(entries.length, "entry count", shard);

  return {
    magic: packedShardHeaderMagic,
    version: packedShardHeaderVersion,
    headerBytes: packedShardHeaderBytes,
    shard,
    shardPath: toPackedShardPath(shardStoreRoot, shard),
    kind,
    kindId: toPackedShardKindId(kind),
    entryCount: entries.length,
    sourceBytes: sumPackedShardBytes(entries, "sourceBytes", shard),
    machineBytes: sumPackedShardBytes(entries, "machineBytes", shard),
    metadataBytes: sumPackedShardBytes(entries, "metadataBytes", shard),
    identity: {
      algorithm: "blake3",
      contentIdAlgorithm: packedShardContentIdAlgorithm,
      sourceBlake3: entries.map(entry => entry.sourceBlake3),
      machineBlake3: entries.map(entry => entry.machineBlake3),
      packageJsonReadIdentity: entries.map(entry =>
        entry.kind === "package_json" ? "serializer-computed-or-none" : "none"
      ),
      sourceInputEncoding: packedShardHeaderSourceIdentityInputEncoding,
      machineInputEncoding: packedShardHeaderMachineIdentityInputEncoding,
    },
    entries: entries.map(toPackedShardHeaderEntry),
  };
}

function toPackedShardHeaderEntry(entry: DxJsMachineCacheCatalogEntry): DxJsMachineCachePackedShardHeaderEntry {
  const headerEntry: DxJsMachineCachePackedShardHeaderEntry = {
    key: entry.key,
    source: entry.source,
    machine: entry.machine,
    metadata: entry.metadata,
    sourceBlake3: entry.sourceBlake3,
    machineBlake3: entry.machineBlake3,
  };
  if (entry.keyInterning) {
    headerEntry.keyInterning = entry.keyInterning;
  }
  return headerEntry;
}

function toPackedShardPath(shardStoreRoot: string, shard: string): string {
  const shardPath = shardStoreRoot ? `${shardStoreRoot}/${shard}.dxjs` : `${shard}.dxjs`;

  return normalizeDxCachePath(shardPath);
}

function toPackedShardKindId(kind: string): number {
  const known = packedShardKindIds[kind];
  if (known !== undefined) {
    return known;
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < kind.length; index += 1) {
    hash ^= kind.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return 1024 + (hash % (0xffff_ffff - 1024));
}

function sumPackedShardBytes(
  entries: DxJsMachineCacheCatalogEntry[],
  field: "sourceBytes" | "machineBytes" | "metadataBytes",
  shard: string,
): number {
  let total = 0;
  for (const entry of entries) {
    total += entry[field];
    if (!Number.isSafeInteger(total)) {
      throw new Error(`DX JS packed shard header ${field} total exceeds safe integer range: ${shard}`);
    }
  }

  return total;
}

function clonePackedShardHeaderLayout(): DxJsMachineCachePackedShardHeaderLayout {
  return {
    ...packedShardHeaderLayout,
    bytemuck: ["Pod", "Zeroable"],
    zerocopy: ["FromBytes", "IntoBytes", "KnownLayout", "Immutable"],
    fields: packedShardHeaderLayout.fields.map(field => ({ ...field })),
  };
}

function assertCanonicalCatalog(catalog: DxJsMachineCacheCatalog): void {
  if (catalog.schema !== catalogSchema) {
    throw new Error(`Unexpected DX JS machine cache catalog schema: ${catalog.schema}`);
  }

  const expectedEntries = catalog.entries
    .map(validateCatalogEntry)
    .sort((left, right) => compareOrdinal(left.key, right.key));
  applyImmutableShardIds(expectedEntries);
  const expectedShards = [...new Set(expectedEntries.map(entry => entry.shard))].sort(compareOrdinal);

  if (JSON.stringify(catalog.entries) !== JSON.stringify(expectedEntries)) {
    throw new Error("DX JS machine cache catalog entries must be sorted and canonical");
  }
  if (JSON.stringify(catalog.shards) !== JSON.stringify(expectedShards)) {
    throw new Error("DX JS machine cache catalog shards must be sorted and canonical");
  }
}

function validateCatalogEntry(entry: DxJsMachineCacheCatalogEntry): DxJsMachineCacheCatalogEntry {
  const source = normalizeDxCachePath(entry.source);
  const kind = entry.kind.trim();
  const machine = normalizeDxCachePath(entry.machine);
  const metadata = normalizeDxCachePath(entry.metadata);

  if (!kind) {
    throw new Error(`DX JS machine cache catalog entry is missing kind: ${entry.source}`);
  }
  if (!entry.sourceBlake3) {
    throw new Error(`DX JS machine cache catalog entry is missing source hash: ${entry.source}`);
  }
  if (!entry.machineBlake3) {
    throw new Error(`DX JS machine cache catalog entry is missing machine hash: ${entry.machine}`);
  }
  assertNonNegativeInteger(entry.sourceBytes, "source bytes", entry.source);
  assertNullableNonNegativeInteger(entry.sourceModifiedUnixMs, "source modified time", entry.source);
  assertNonNegativeInteger(entry.machineBytes, "machine bytes", entry.machine);
  assertNonNegativeInteger(entry.metadataBytes, "metadata bytes", entry.metadata);

  return {
    key: `${kind}\0${source}`,
    kind,
    source,
    shard: kind,
    machine,
    metadata,
    keyInterning: normalizeOptionalDxCachePath(entry.keyInterning),
    sourceBytes: entry.sourceBytes,
    sourceModifiedUnixMs: entry.sourceModifiedUnixMs,
    sourceBlake3: entry.sourceBlake3,
    machineBlake3: entry.machineBlake3,
    machineBytes: entry.machineBytes,
    metadataBytes: entry.metadataBytes,
  };
}

function assertNonNegativeInteger(value: number, label: string, source: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`DX JS machine cache catalog entry has invalid ${label}: ${source}`);
  }
}

function normalizeOptionalDxCachePath(value: string | undefined): string | undefined {
  return value ? normalizeDxCachePath(value) : undefined;
}

function assertNullableNonNegativeInteger(value: number | null, label: string, source: string): void {
  if (value !== null) {
    assertNonNegativeInteger(value, label, source);
  }
}

function assertU32(value: number, label: string, source: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`DX JS machine cache catalog entry has invalid ${label}: ${source}`);
  }
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function mismatch(
  reason: Exclude<DxJsMachineCacheBinaryCatalogContractValidation, { ok: true }>["reason"],
  message: string,
): DxJsMachineCacheBinaryCatalogContractValidation {
  return {
    ok: false,
    reason,
    message,
  };
}

function packedShardHeaderMismatch(
  reason: Exclude<DxJsMachineCachePackedShardHeaderContractValidation, { ok: true }>["reason"],
  message: string,
): DxJsMachineCachePackedShardHeaderContractValidation {
  return {
    ok: false,
    reason,
    message,
  };
}
