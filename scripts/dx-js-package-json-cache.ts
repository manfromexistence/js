import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizeDxCachePath, toDxStatCacheKey } from "./dx-js-cache-path-contract.ts";

export type DxJsMachineCacheEntry = {
  source: string;
  kind: string;
  stem: string;
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

export type DxJsMachineCacheIndex = {
  schema: string;
  generatedAtUtc: string;
  entries: DxJsMachineCacheEntry[];
};

export type DxJsMachineCacheTrustedKind = "package_json" | "tsconfig" | "bunfig";

export type DxJsMachineCacheValidationReason =
  | "missing_entry"
  | "unsupported_kind"
  | "unexpected_kind"
  | "missing_source"
  | "missing_machine"
  | "missing_metadata"
  | "metadata_schema_mismatch"
  | "metadata_parse_error"
  | "metadata_bytes_mismatch"
  | "source_bytes_mismatch"
  | "source_mtime_newer"
  | "source_blake3_mismatch"
  | "machine_bytes_mismatch"
  | "machine_blake3_mismatch"
  | "machine_bytecheck_failed";

export type DxJsMachineCacheValidation =
  | { ok: true }
  | {
      ok: false;
      reason: DxJsMachineCacheValidationReason;
    };

export type PackageJsonCacheValidation = DxJsMachineCacheValidation;

export type PackageJsonKeyInterningSidecarValidationReason =
  | "missing_entry"
  | "unexpected_kind"
  | "missing_key_interning"
  | "invalid_key_interning_path"
  | "missing_key_interning_sidecar"
  | "key_interning_parse_error"
  | "key_interning_schema_mismatch"
  | "key_interning_invalid_shape"
  | "key_interning_totals_mismatch"
  | "key_interning_keys_not_canonical";

export type PackageJsonMetadataFields = {
  dependencies: boolean;
  exports: boolean;
  imports: boolean;
  name: boolean;
  scripts: boolean;
  type: boolean;
};

export type PackageJsonKeyInterningSidecarKey = {
  key: string;
  occurrences: number;
  extraOccurrences: number;
  keyUtf8Bytes: number;
  quotedKeyBytes: number;
  estimatedSavedQuotedKeyBytes: number;
};

export type PackageJsonKeyInterningSidecarContract = {
  schema: "dx.package_json.key_interning_sidecar.v1";
  sourceFormat: "package_json";
  keyEncoding: "utf8";
  objectKeyOccurrences: number;
  uniqueKeys: number;
  repeatedKeys: number;
  repeatedKeyOccurrences: number;
  extraRepeatedKeyOccurrences: number;
  estimated: {
    originalQuotedKeyBytes: number;
    internedUniqueQuotedKeyBytes: number;
    savedQuotedKeyBytes: number;
  };
  keys: PackageJsonKeyInterningSidecarKey[];
};

export type DxJsMachineCacheMetadata = {
  schema?: string;
  source?: { bytes?: number; modified_unix_ms?: number | null; blake3?: string };
  machine?: { bytes?: number; blake3?: string };
};

export type DxJsMachineCacheBytecheckInput = {
  kind: DxJsMachineCacheTrustedKind;
  source: string;
  machine: string;
  entry: DxJsMachineCacheEntry;
  machinePath: string;
  machineBytes: Uint8Array;
};

export type ValidateDxJsMachineCacheOptions = {
  kind?: DxJsMachineCacheTrustedKind;
  hashSource?: (sourcePath: string) => string | Promise<string>;
  hashMachine?: (machinePath: string, machineBytes: Uint8Array) => string | Promise<string>;
  bytecheckMachine?: (input: DxJsMachineCacheBytecheckInput) => boolean | Promise<boolean>;
};

export type ValidatePackageJsonCacheOptions = Omit<ValidateDxJsMachineCacheOptions, "kind">;

export type ReadTrustedDxJsMachineCacheOptions = {
  kind: DxJsMachineCacheTrustedKind;
  hashSource: (sourcePath: string) => string | Promise<string>;
  hashMachine: (machinePath: string, machineBytes: Uint8Array) => string | Promise<string>;
  bytecheckMachine: (input: DxJsMachineCacheBytecheckInput) => boolean | Promise<boolean>;
};

export type TrustedDxJsMachineCacheEntry = {
  ok: true;
  trusted: true;
  kind: DxJsMachineCacheTrustedKind;
  source: string;
  machine: string;
  metadata: string;
  sourcePath: string;
  machinePath: string;
  metadataPath: string;
  entry: DxJsMachineCacheEntry;
  metadataJson: DxJsMachineCacheMetadata;
  machineBytes: Uint8Array;
};

export type ReadTrustedDxJsMachineCacheResult =
  | TrustedDxJsMachineCacheEntry
  | { ok: false; reason: DxJsMachineCacheValidationReason };

export type TrustedPackageJsonKeyInterningSidecar = {
  ok: true;
  trusted: true;
  keyInterning: string;
  keyInterningPath: string;
  sidecarBytes: number;
  sidecar: PackageJsonKeyInterningSidecarContract;
};

export type ReadTrustedPackageJsonKeyInterningSidecarResult =
  | TrustedPackageJsonKeyInterningSidecar
  | { ok: false; reason: PackageJsonKeyInterningSidecarValidationReason };

const cacheIndexSchema = "dx.js.machine_cache_index.v1";
const metadataSchema = "dx.machine.source_metadata.v1";
const packageJsonKeyInterningSidecarSchema = "dx.package_json.key_interning_sidecar.v1";
const packageJsonFields = ["dependencies", "exports", "imports", "name", "scripts", "type"] as const;
const trustedSidecarKinds = new Set<DxJsMachineCacheTrustedKind>(["package_json", "tsconfig", "bunfig"]);

export async function loadDxJsMachineCacheIndex(
  root: string,
  indexPath = ".dx/js/index.json",
): Promise<DxJsMachineCacheIndex> {
  const absoluteIndexPath = path.resolve(root, ...normalizeDxCachePath(indexPath).split("/"));
  const index = JSON.parse(await fs.readFile(absoluteIndexPath, "utf8")) as DxJsMachineCacheIndex;

  if (index.schema !== cacheIndexSchema) {
    throw new Error(`Unexpected DX JS machine cache schema: ${index.schema}`);
  }

  index.entries = index.entries.map((entry) => ({
    ...entry,
    machine: normalizeDxCachePath(entry.machine),
    metadata: normalizeDxCachePath(entry.metadata),
    source: normalizeDxCachePath(entry.source),
  }));

  assertNoWindowsStatKeyCollisions(root, index.entries);

  return index;
}

export function findPackageJsonCacheEntry(
  index: DxJsMachineCacheIndex,
  source: string,
): DxJsMachineCacheEntry | undefined {
  return findDxJsMachineCacheEntry(index, "package_json", source);
}

export function findDxJsMachineCacheEntry(
  index: DxJsMachineCacheIndex,
  kind: DxJsMachineCacheTrustedKind,
  source: string,
): DxJsMachineCacheEntry | undefined {
  const normalizedSource = normalizeDxCachePath(source);

  return index.entries.find(
    (entry) => entry.kind === kind && normalizeDxCachePath(entry.source) === normalizedSource,
  );
}

export async function validatePackageJsonCacheEntry(
  root: string,
  entry: DxJsMachineCacheEntry | undefined,
  options: ValidatePackageJsonCacheOptions = {},
): Promise<PackageJsonCacheValidation> {
  return validateDxJsMachineCacheEntry(root, entry, { ...options, kind: "package_json" });
}

export async function validateDxJsMachineCacheEntry(
  root: string,
  entry: DxJsMachineCacheEntry | undefined,
  options: ValidateDxJsMachineCacheOptions = {},
): Promise<DxJsMachineCacheValidation> {
  const result = await validateDxJsMachineCacheEntryInternal(root, entry, options, false);

  return result.ok ? { ok: true } : result;
}

export async function readTrustedDxJsMachineCacheEntry(
  root: string,
  entry: DxJsMachineCacheEntry | undefined,
  options: ReadTrustedDxJsMachineCacheOptions,
): Promise<ReadTrustedDxJsMachineCacheResult> {
  const result = await validateDxJsMachineCacheEntryInternal(root, entry, options, true);
  if (!result.ok) {
    return result;
  }

  const { context } = result;

  return {
    ok: true,
    trusted: true,
    kind: context.kind,
    source: context.entry.source,
    machine: context.entry.machine,
    metadata: context.entry.metadata,
    sourcePath: context.sourcePath,
    machinePath: context.machinePath,
    metadataPath: context.metadataPath,
    entry: context.entry,
    metadataJson: context.metadata,
    machineBytes: context.machineBytes,
  };
}

export async function readTrustedPackageJsonKeyInterningSidecar(
  root: string,
  entry: DxJsMachineCacheEntry | undefined,
): Promise<ReadTrustedPackageJsonKeyInterningSidecarResult> {
  if (!entry) {
    return { ok: false, reason: "missing_entry" };
  }
  if (entry.kind !== "package_json") {
    return { ok: false, reason: "unexpected_kind" };
  }
  if (!entry.keyInterning) {
    return { ok: false, reason: "missing_key_interning" };
  }

  let keyInterning = "";
  try {
    keyInterning = normalizeDxCachePath(entry.keyInterning);
  } catch {
    return { ok: false, reason: "invalid_key_interning_path" };
  }

  let keyInterningPath = "";
  try {
    keyInterningPath = resolveRepoPath(root, keyInterning);
  } catch {
    return { ok: false, reason: "invalid_key_interning_path" };
  }
  let text = "";
  try {
    text = await fs.readFile(keyInterningPath, "utf8");
  } catch {
    return { ok: false, reason: "missing_key_interning_sidecar" };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "key_interning_parse_error" };
  }

  const validation = validatePackageJsonKeyInterningSidecar(value);
  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    trusted: true,
    keyInterning,
    keyInterningPath,
    sidecarBytes: Buffer.byteLength(text),
    sidecar: validation.sidecar,
  };
}

type DxJsMachineCacheValidationContext = {
  kind: DxJsMachineCacheTrustedKind;
  entry: DxJsMachineCacheEntry;
  metadata: DxJsMachineCacheMetadata;
  sourcePath: string;
  machinePath: string;
  metadataPath: string;
  machineBytes: Uint8Array;
};

type DxJsMachineCacheInternalValidation =
  | { ok: true; context: DxJsMachineCacheValidationContext }
  | { ok: false; reason: DxJsMachineCacheValidationReason };

async function validateDxJsMachineCacheEntryInternal(
  root: string,
  entry: DxJsMachineCacheEntry | undefined,
  options: ValidateDxJsMachineCacheOptions,
  readMachineBytes: boolean,
): Promise<DxJsMachineCacheInternalValidation> {
  if (!entry) {
    return { ok: false, reason: "missing_entry" };
  }

  const kind = toTrustedSidecarKind(entry.kind);
  if (!kind) {
    return { ok: false, reason: "unsupported_kind" };
  }
  if (options.kind && kind !== options.kind) {
    return { ok: false, reason: "unexpected_kind" };
  }

  const normalizedSource = normalizeDxCachePath(entry.source);
  const normalizedMachine = normalizeDxCachePath(entry.machine);
  const normalizedMetadata = normalizeDxCachePath(entry.metadata);
  if (
    entry.source !== normalizedSource ||
    entry.machine !== normalizedMachine ||
    entry.metadata !== normalizedMetadata
  ) {
    entry = {
      ...entry,
      machine: normalizedMachine,
      metadata: normalizedMetadata,
      source: normalizedSource,
    };
  }

  const sourcePath = resolveRepoPath(root, entry.source);
  const machinePath = resolveRepoPath(root, entry.machine);
  const metadataPath = resolveRepoPath(root, entry.metadata);

  const [sourceStat, machineStat, metadataResult] = await Promise.all([
    statOrNull(sourcePath),
    statOrNull(machinePath),
    readMetadataFile(metadataPath),
  ]);

  if (!sourceStat) {
    return { ok: false, reason: "missing_source" };
  }
  if (!machineStat) {
    return { ok: false, reason: "missing_machine" };
  }
  if (!metadataResult.ok) {
    return metadataResult;
  }

  const { metadata, metadataBytes } = metadataResult;

  if (metadata.schema !== metadataSchema) {
    return { ok: false, reason: "metadata_schema_mismatch" };
  }

  if (metadataBytes !== entry.metadataBytes) {
    return { ok: false, reason: "metadata_bytes_mismatch" };
  }

  if (sourceStat.size !== entry.sourceBytes || sourceStat.size !== metadata.source?.bytes) {
    return { ok: false, reason: "source_bytes_mismatch" };
  }

  if (
    typeof entry.sourceModifiedUnixMs === "number" &&
    Math.trunc(sourceStat.mtimeMs) > entry.sourceModifiedUnixMs
  ) {
    return { ok: false, reason: "source_mtime_newer" };
  }

  if (options.hashSource) {
    const actualHash = await options.hashSource(sourcePath);
    if (actualHash !== entry.sourceBlake3 || actualHash !== metadata.source?.blake3) {
      return { ok: false, reason: "source_blake3_mismatch" };
    }
  }

  if (machineStat.size !== entry.machineBytes || machineStat.size !== metadata.machine?.bytes) {
    return { ok: false, reason: "machine_bytes_mismatch" };
  }

  if (metadata.machine?.blake3 !== entry.machineBlake3) {
    return { ok: false, reason: "machine_blake3_mismatch" };
  }

  let machineBytes: Uint8Array | undefined;
  const readMachine = async (): Promise<Uint8Array> => {
    if (!machineBytes) {
      machineBytes = await fs.readFile(machinePath);
    }

    if (machineBytes.byteLength !== entry.machineBytes || machineBytes.byteLength !== metadata.machine?.bytes) {
      throw new MachineBytesMismatch();
    }

    return machineBytes;
  };

  try {
    if (options.hashMachine) {
      const actualMachineHash = await options.hashMachine(machinePath, await readMachine());
      if (actualMachineHash !== entry.machineBlake3 || actualMachineHash !== metadata.machine.blake3) {
        return { ok: false, reason: "machine_blake3_mismatch" };
      }
    }

    if (options.bytecheckMachine) {
      const accepted = await options.bytecheckMachine({
        kind,
        source: entry.source,
        machine: entry.machine,
        entry,
        machinePath,
        machineBytes: await readMachine(),
      });

      if (!accepted) {
        return { ok: false, reason: "machine_bytecheck_failed" };
      }
    }

    if (readMachineBytes) {
      await readMachine();
    }
  } catch (error) {
    if (error instanceof MachineBytesMismatch) {
      return { ok: false, reason: "machine_bytes_mismatch" };
    }

    throw error;
  }

  return {
    ok: true,
    context: {
      kind,
      entry,
      metadata,
      sourcePath,
      machinePath,
      metadataPath,
      machineBytes: machineBytes ?? new Uint8Array(),
    },
  };
}

export function scanPackageJsonMetadataFallback(source: string | Uint8Array): PackageJsonMetadataFields {
  const text = typeof source === "string" ? source : new TextDecoder().decode(source);
  const fields = Object.fromEntries(packageJsonFields.map((field) => [field, false])) as PackageJsonMetadataFields;

  scanJsonObjectKeys(text, (key) => {
    if (isPackageJsonField(key)) {
      fields[key] = true;
    }
  });

  return fields;
}

export function scanPackageJsonKeyInterningSidecarContract(
  source: string | Uint8Array,
): PackageJsonKeyInterningSidecarContract {
  const text = typeof source === "string" ? source : new TextDecoder().decode(source);
  const counts = new Map<string, number>();

  scanJsonObjectKeys(text, (key) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  const keys = [...counts.entries()]
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([key, occurrences]) => {
      const keyUtf8Bytes = Buffer.byteLength(key);
      const quotedKeyBytes = Buffer.byteLength(JSON.stringify(key)) + 1;
      const extraOccurrences = Math.max(0, occurrences - 1);

      return {
        key,
        occurrences,
        extraOccurrences,
        keyUtf8Bytes,
        quotedKeyBytes,
        estimatedSavedQuotedKeyBytes: extraOccurrences * quotedKeyBytes,
      };
    });

  let objectKeyOccurrences = 0;
  let repeatedKeys = 0;
  let repeatedKeyOccurrences = 0;
  let extraRepeatedKeyOccurrences = 0;
  let originalQuotedKeyBytes = 0;
  let internedUniqueQuotedKeyBytes = 0;
  let savedQuotedKeyBytes = 0;

  for (const key of keys) {
    objectKeyOccurrences += key.occurrences;
    originalQuotedKeyBytes += key.occurrences * key.quotedKeyBytes;
    internedUniqueQuotedKeyBytes += key.quotedKeyBytes;
    savedQuotedKeyBytes += key.estimatedSavedQuotedKeyBytes;

    if (key.occurrences > 1) {
      repeatedKeys++;
      repeatedKeyOccurrences += key.occurrences;
      extraRepeatedKeyOccurrences += key.extraOccurrences;
    }
  }

  return {
    schema: packageJsonKeyInterningSidecarSchema,
    sourceFormat: "package_json",
    keyEncoding: "utf8",
    objectKeyOccurrences,
    uniqueKeys: keys.length,
    repeatedKeys,
    repeatedKeyOccurrences,
    extraRepeatedKeyOccurrences,
    estimated: {
      originalQuotedKeyBytes,
      internedUniqueQuotedKeyBytes,
      savedQuotedKeyBytes,
    },
    keys,
  };
}

function resolveRepoPath(root: string, repoPath: string): string {
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, ...normalizeDxCachePath(repoPath).split("/"));
  const relative = path.relative(absoluteRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`DX cache paths must stay inside the repo: ${repoPath}`);
  }

  return resolved;
}

function validatePackageJsonKeyInterningSidecar(
  value: unknown,
):
  | { ok: true; sidecar: PackageJsonKeyInterningSidecarContract }
  | { ok: false; reason: PackageJsonKeyInterningSidecarValidationReason } {
  if (!isRecord(value)) {
    return { ok: false, reason: "key_interning_invalid_shape" };
  }
  if (
    value.schema !== packageJsonKeyInterningSidecarSchema ||
    value.sourceFormat !== "package_json" ||
    value.keyEncoding !== "utf8"
  ) {
    return { ok: false, reason: "key_interning_schema_mismatch" };
  }
  if (!isRecord(value.estimated) || !Array.isArray(value.keys)) {
    return { ok: false, reason: "key_interning_invalid_shape" };
  }

  const topLevelNumbers = [
    "objectKeyOccurrences",
    "uniqueKeys",
    "repeatedKeys",
    "repeatedKeyOccurrences",
    "extraRepeatedKeyOccurrences",
  ] as const;
  const estimatedNumbers = [
    "originalQuotedKeyBytes",
    "internedUniqueQuotedKeyBytes",
    "savedQuotedKeyBytes",
  ] as const;

  for (const field of topLevelNumbers) {
    if (!isNonNegativeSafeInteger(value[field])) {
      return { ok: false, reason: "key_interning_invalid_shape" };
    }
  }
  for (const field of estimatedNumbers) {
    if (!isNonNegativeSafeInteger(value.estimated[field])) {
      return { ok: false, reason: "key_interning_invalid_shape" };
    }
  }

  const keys: PackageJsonKeyInterningSidecarKey[] = [];
  let previousKey: string | undefined;

  for (const entry of value.keys) {
    if (!isRecord(entry) || typeof entry.key !== "string") {
      return { ok: false, reason: "key_interning_invalid_shape" };
    }
    if (previousKey !== undefined && compareOrdinal(previousKey, entry.key) >= 0) {
      return { ok: false, reason: "key_interning_keys_not_canonical" };
    }
    previousKey = entry.key;

    const numericFields = [
      "occurrences",
      "extraOccurrences",
      "keyUtf8Bytes",
      "quotedKeyBytes",
      "estimatedSavedQuotedKeyBytes",
    ] as const;
    for (const field of numericFields) {
      if (!isNonNegativeSafeInteger(entry[field])) {
        return { ok: false, reason: "key_interning_invalid_shape" };
      }
    }

    const key = {
      key: entry.key,
      occurrences: entry.occurrences as number,
      extraOccurrences: entry.extraOccurrences as number,
      keyUtf8Bytes: entry.keyUtf8Bytes as number,
      quotedKeyBytes: entry.quotedKeyBytes as number,
      estimatedSavedQuotedKeyBytes: entry.estimatedSavedQuotedKeyBytes as number,
    };

    const quotedKeyBytes = Buffer.byteLength(JSON.stringify(key.key)) + 1;
    if (
      key.keyUtf8Bytes !== Buffer.byteLength(key.key) ||
      key.quotedKeyBytes !== quotedKeyBytes ||
      key.extraOccurrences !== Math.max(0, key.occurrences - 1) ||
      key.estimatedSavedQuotedKeyBytes !== key.extraOccurrences * quotedKeyBytes
    ) {
      return { ok: false, reason: "key_interning_totals_mismatch" };
    }

    keys.push(key);
  }

  const totals = summarizePackageJsonKeyInterningSidecarKeys(keys);
  if (
    value.objectKeyOccurrences !== totals.objectKeyOccurrences ||
    value.uniqueKeys !== totals.uniqueKeys ||
    value.repeatedKeys !== totals.repeatedKeys ||
    value.repeatedKeyOccurrences !== totals.repeatedKeyOccurrences ||
    value.extraRepeatedKeyOccurrences !== totals.extraRepeatedKeyOccurrences ||
    value.estimated.originalQuotedKeyBytes !== totals.estimated.originalQuotedKeyBytes ||
    value.estimated.internedUniqueQuotedKeyBytes !== totals.estimated.internedUniqueQuotedKeyBytes ||
    value.estimated.savedQuotedKeyBytes !== totals.estimated.savedQuotedKeyBytes
  ) {
    return { ok: false, reason: "key_interning_totals_mismatch" };
  }

  return {
    ok: true,
    sidecar: {
      schema: packageJsonKeyInterningSidecarSchema,
      sourceFormat: "package_json",
      keyEncoding: "utf8",
      ...totals,
      keys,
    },
  };
}

function summarizePackageJsonKeyInterningSidecarKeys(keys: PackageJsonKeyInterningSidecarKey[]) {
  let objectKeyOccurrences = 0;
  let repeatedKeys = 0;
  let repeatedKeyOccurrences = 0;
  let extraRepeatedKeyOccurrences = 0;
  let originalQuotedKeyBytes = 0;
  let internedUniqueQuotedKeyBytes = 0;
  let savedQuotedKeyBytes = 0;

  for (const key of keys) {
    objectKeyOccurrences += key.occurrences;
    originalQuotedKeyBytes += key.occurrences * key.quotedKeyBytes;
    internedUniqueQuotedKeyBytes += key.quotedKeyBytes;
    savedQuotedKeyBytes += key.estimatedSavedQuotedKeyBytes;

    if (key.occurrences > 1) {
      repeatedKeys++;
      repeatedKeyOccurrences += key.occurrences;
      extraRepeatedKeyOccurrences += key.extraOccurrences;
    }
  }

  return {
    objectKeyOccurrences,
    uniqueKeys: keys.length,
    repeatedKeys,
    repeatedKeyOccurrences,
    extraRepeatedKeyOccurrences,
    estimated: {
      originalQuotedKeyBytes,
      internedUniqueQuotedKeyBytes,
      savedQuotedKeyBytes,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function statOrNull(target: string) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function isPackageJsonField(value: string): value is keyof PackageJsonMetadataFields {
  return packageJsonFields.includes(value as keyof PackageJsonMetadataFields);
}

function toTrustedSidecarKind(value: string): DxJsMachineCacheTrustedKind | undefined {
  return trustedSidecarKinds.has(value as DxJsMachineCacheTrustedKind)
    ? (value as DxJsMachineCacheTrustedKind)
    : undefined;
}

async function readMetadataFile(
  metadataPath: string,
): Promise<
  | { ok: true; metadata: DxJsMachineCacheMetadata; metadataBytes: number }
  | { ok: false; reason: "missing_metadata" | "metadata_parse_error" }
> {
  let metadataText: string;
  try {
    metadataText = await fs.readFile(metadataPath, "utf8");
  } catch {
    return { ok: false, reason: "missing_metadata" };
  }

  try {
    return {
      ok: true,
      metadata: JSON.parse(metadataText) as DxJsMachineCacheMetadata,
      metadataBytes: Buffer.byteLength(metadataText),
    };
  } catch {
    return { ok: false, reason: "metadata_parse_error" };
  }
}

class MachineBytesMismatch extends Error {}

function scanJsonObjectKeys(text: string, onKey: (key: string) => void): void {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 34) {
      continue;
    }

    const keyStart = i + 1;
    let keyEnd = keyStart;
    let escaped = false;
    for (; keyEnd < text.length; keyEnd++) {
      const char = text[keyEnd];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        break;
      }
    }

    if (keyEnd >= text.length) {
      break;
    }

    let cursor = keyEnd + 1;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor++;
    }

    if (text[cursor] !== ":") {
      i = keyEnd;
      continue;
    }

    onKey(parseJsonStringLiteral(text.slice(i, keyEnd + 1), text.slice(keyStart, keyEnd)));
    i = keyEnd;
  }
}

function parseJsonStringLiteral(quoted: string, fallback: string): string {
  try {
    const value = JSON.parse(quoted);
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
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

function assertNoWindowsStatKeyCollisions(root: string, entries: DxJsMachineCacheEntry[]): void {
  const seen = new Map<string, string>();

  for (const entry of entries) {
    if (!toTrustedSidecarKind(entry.kind)) {
      continue;
    }

    const key = toDxStatCacheKey(root, entry.source, "win32");
    const previous = seen.get(key);
    if (previous) {
      throw new Error(`Duplicate DX JS machine cache stat key: ${previous} and ${entry.source}`);
    }

    seen.set(key, entry.source);
  }
}
