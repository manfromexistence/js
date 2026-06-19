import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, ...relativePath.split("/")), "utf8");
}

function sourceAround(source: string, needle: string): string {
  const index = source.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return source.slice(index, index + 4000);
}

test("wires dx machine cache as opt-in shadow validation on normal config parse paths", () => {
  const machineCache = readRepoFile("src/resolver/dx_machine_cache.rs");
  const packageJson = readRepoFile("src/resolver/package_json.rs");
  const tsconfig = readRepoFile("src/resolver/tsconfig_json.rs");
  const bunfig = readRepoFile("src/bunfig/bunfig.rs");
  const packageJsonProbe = sourceAround(packageJson, "shadow_probe_source_or_warn(");
  const tsconfigProbe = sourceAround(tsconfig, "shadow_probe_source_or_warn(");
  const bunfigProbe = sourceAround(bunfig, "shadow_probe_source_or_warn(");

  expect(machineCache).toContain('const SHADOW_ENV: &str = "BUN_DX_MACHINE_CACHE_SHADOW";');
  expect(machineCache).toContain('const READ_ENV: &str = "BUN_DX_MACHINE_CACHE_READ";');
  expect(machineCache).toContain('const FAST_READ_ENV: &str = "BUN_DX_MACHINE_CACHE_READ_FAST";');
  expect(machineCache).toContain('const DISABLE_ENV: &str = "BUN_DX_MACHINE_CACHE_DISABLE";');
  expect(machineCache).toContain('const CACHE_ROOT_ENV: &str = "BUN_DX_MACHINE_CACHE_ROOT";');
  expect(machineCache).toContain('const TRUST_DOCUMENT_ENV: &str = "BUN_DX_MACHINE_CACHE_TRUST_DOCUMENT";');
  expect(machineCache).toContain(
    'const TRUST_SOURCE_METADATA_ENV: &str = "BUN_DX_MACHINE_CACHE_TRUST_SOURCE_METADATA";',
  );
  expect(machineCache).toContain(
    'const TRUST_PACKAGE_JSON_READ_ENV: &str = "BUN_DX_MACHINE_CACHE_TRUST_PACKAGE_JSON_READ";',
  );
  expect(machineCache).toContain('const TRUSTED_PACKAGE_JSON_SNAPSHOT_MARKER: &str = "package-json-read.trusted";');
  expect(machineCache).toContain('const BUFFER_DOCUMENTS_ENV: &str = "BUN_DX_MACHINE_CACHE_BUFFER_DOCUMENTS";');
  expect(machineCache).toContain(
    'const PACKED_DOCUMENT_READ_ENV: &str = "BUN_DX_MACHINE_CACHE_READ_PACKED_DOCUMENTS";',
  );
  expect(machineCache).toContain(
    'const PACKED_PACKAGE_JSON_READ_ENV: &str = "BUN_DX_MACHINE_CACHE_READ_PACKED_PACKAGE_JSON";',
  );
  expect(machineCache).toContain(
    'const SHARD_MACHINE_SCHEMA_V2: &str = "dx.js.machine_cache_packed_shard.rkyv_documents.v2";',
  );
  expect(machineCache).toContain(
    'const SHARD_MACHINE_SCHEMA_V3: &str = "dx.js.machine_cache_packed_shard.rkyv_package_json_read.v3";',
  );
  expect(machineCache).toContain("const SHARD_MACHINE_SCHEMA_V4: &str =");
  expect(machineCache).toContain('"dx.js.machine_cache_packed_shard.rkyv_package_json_read_identity.v4"');
  expect(machineCache).toContain("const SHARD_MACHINE_SCHEMA_V5: &str =");
  expect(machineCache).toContain('"dx.js.machine_cache_packed_shard.rkyv_package_json_resolver_read_identity.v5"');
  expect(machineCache).toContain("pub fn shadow_probe_enabled() -> bool");
  expect(machineCache).toContain("PACKAGE_JSON_READ_ALLOWED_KEYS");
  expect(machineCache).toContain('"main"');
  expect(machineCache).toContain('"module"');
  expect(machineCache).toContain('"browser"');
  expect(machineCache).toContain('"jsnext:main"');
  expect(machineCache).toContain('"sideEffects"');
  expect(machineCache).toContain("fn package_json_source_has_unsupported_read_keys(");
  expect(machineCache).toContain("fn package_json_source_string_bounds(");
  expect(machineCache).toContain("fn package_json_next_non_whitespace(");
  expect(machineCache).toContain("depth == 1");
  expect(machineCache).toContain("if package_json_source_has_unsupported_read_keys(source_bytes)");
  expect(machineCache).not.toContain("source_bytes.windows(needle_len)");
  expect(machineCache).not.toContain("fn package_json_source_contains_quoted_key(");
  expect(machineCache).toContain("pub fn read_through_enabled() -> bool");
  expect(machineCache).toContain("pub fn machine_cache_disabled() -> bool");
  expect(machineCache).toContain("pub fn integrated_read_enabled() -> bool");
  expect(machineCache).toContain("pub fn fast_read_enabled() -> bool");
  expect(machineCache).toContain("pub fn package_json_path_read_enabled() -> bool");
  expect(machineCache).toContain("pub fn trust_document_enabled() -> bool");
  expect(machineCache).toContain("pub fn trust_source_metadata_enabled() -> bool");
  expect(machineCache).toContain("pub fn trust_package_json_read_enabled() -> bool");
  expect(machineCache).toContain("fn trust_package_json_snapshot_enabled() -> bool");
  expect(machineCache).toContain("trust_source_metadata_enabled() && trust_package_json_read_enabled()");
  expect(machineCache).toContain("fn trusted_package_json_snapshot_for_root(root: &Path) -> bool");
  expect(machineCache).toContain("root_has_trusted_package_json_snapshot(root)");
  expect(machineCache).toContain("fn root_has_trusted_package_json_snapshot(root: &Path) -> bool");
  const catalogOpen = sourceAround(machineCache, "impl TrustedCatalogMachine");
  expect(catalogOpen).toContain("Self::open_with_trust(path, trust_package_json_snapshot_enabled())");
  expect(catalogOpen).toContain("trust_package_json_snapshot: bool");
  expect(machineCache).toContain("type FastHashMap<K, V> = HashMap<K, V, bun_wyhash::BuildHasher>;");
  expect(machineCache).toContain(
    "package_json_source_index: OnceLock<FastHashMap<Box<str>, PackageJsonSourceIndexEntry>>",
  );
  expect(machineCache).toContain(
    "package_json_path_index: OnceLock<FastHashMap<PathBuf, PackageJsonSourceIndexEntry>>",
  );
  expect(machineCache).toContain(
    "package_json_node_modules_index: OnceLock<FastHashMap<Box<str>, PackageJsonSourceIndexEntry>>",
  );
  expect(machineCache).toContain("struct PackageJsonSourceIndexEntry");
  expect(catalogOpen).toContain("package_json_source_index: OnceLock::new()");
  expect(catalogOpen).toContain("package_json_node_modules_index: OnceLock::new()");
  expect(catalogOpen).toContain("package_json_path_index: OnceLock::new()");
  expect(catalogOpen).toContain("fn find_package_json_entry(");
  expect(catalogOpen).toContain("bytecheck_catalog(path, &mmap)?;");
  expect(catalogOpen).toContain("validate_catalog(path, catalog)?;");
  const cachedShard = sourceAround(machineCache, "fn cached_shard_for_entry(");
  expect(cachedShard).toContain("let trusted_package_json_snapshot = trusted_package_json_snapshot_for_root(root);");
  expect(cachedShard).toContain("if !trusted_package_json_snapshot");
  expect(cachedShard).toContain("catalog.validate_shard(&path, &shard, entry.shard, entry.key)?;");
  const shardOpen = sourceAround(machineCache, "impl TrustedPackedShardMachine");
  expect(shardOpen).toContain("Self::open_with_trust(path, trust_package_json_snapshot_enabled())");
  expect(shardOpen).toContain("trust_package_json_snapshot: bool");
  expect(shardOpen).toContain("bytecheck_shard_v3(path, body)?;");
  expect(shardOpen).toContain("validate_packed_shard_v4(path, header, shard)?;");
  expect(machineCache).toContain("pub fn buffer_documents_enabled() -> bool");
  expect(machineCache).toContain("pub fn packed_document_read_enabled() -> bool");
  expect(machineCache).toContain("pub fn packed_package_json_read_enabled() -> bool");
  expect(machineCache).toContain("struct JsCacheShardMachineV2");
  expect(machineCache).toContain("struct JsCacheShardMachineV3");
  expect(machineCache).toContain("machine_document: Option<Vec<u8>>");
  expect(machineCache).toContain("package_json_read: Option<PackageJsonReadMachine>");
  expect(machineCache).toContain("enum PackageJsonReadMachineValue");
  expect(machineCache).toContain("fn cached_document_for_packed_shard_entry(");
  expect(machineCache).toContain("let use_packed_document = packed_document_read_enabled();");
  expect(machineCache).toContain("source_bytes.is_some() || trusted_package_json_snapshot || trust_package_json_read");
  expect(machineCache).toContain("enum TrustedMachineDocumentBacking");
  expect(machineCache).toContain("TrustedMachineDocumentBacking::Mmap");
  expect(machineCache).toContain("TrustedMachineDocumentBacking::Bytes");
  expect(machineCache).toContain("fn read_machine_file(path: &Path)");
  expect(machineCache).toContain("if buffer_documents_enabled()");
  expect(machineCache).toContain("enum MachineDocumentIntegrity");
  expect(machineCache).toContain("MachineDocumentIntegrity::EnvelopePayload");
  expect(machineCache).toContain("MachineDocumentIntegrity::FullFileHash");
  expect(machineCache).toContain("fn machine_document_integrity()");
  expect(machineCache).toContain("MachineDocumentIntegrity::FullFileHash => {");
  expect(machineCache).toContain("let machine_bytes = backing.bytes();");
  expect(machineCache).toContain("if !blake3_matches_hex(machine_bytes, expected_blake3)");
  expect(machineCache).toContain("MachineDocumentIntegrity::EnvelopePayload => {}");
  expect(machineCache).not.toContain("let _ = integrity;");
  expect(machineCache).toContain("fn shadow_env_truthy(value: &std::ffi::OsStr) -> bool");
  expect(machineCache).toContain('matches!(text, "1" | "true" | "yes" | "on")');
  expect(machineCache).not.toContain("std::env::var_os(SHADOW_ENV).is_some()");
  expect(machineCache).toContain("pub fn shadow_probe_source(");
  expect(machineCache).toContain("pub fn shadow_probe_source_or_warn(");
  expect(machineCache).toContain("pub fn package_json_read_source_or_warn(");
  expect(machineCache).toContain("pub fn package_json_read_path_or_warn(");
  expect(machineCache).not.toContain("#[cold]\n#[inline(never)]\nfn package_json_read_path_enabled");
  expect(machineCache).toContain("PackageJsonMachineRead");
  expect(machineCache).toContain("PackageJsonMachineValue");
  expect(machineCache).toContain("PackageJsonMachineReadRef");
  expect(machineCache).toContain("PackageJsonMachineValueRef");
  expect(machineCache).toContain("PackageJsonMachineValueKind");
  expect(machineCache).toContain("pub fn as_static_str(self) -> Option<&'static [u8]>");
  expect(machineCache).toContain("pub fn object_field_static(");
  expect(machineCache).toContain("bun_ptr::detach_lifetime");
  expect(machineCache).toContain("pub name: Option<Box<[u8]>>");
  expect(machineCache).toContain("pub version: Option<Box<[u8]>>");
  expect(machineCache).toContain("pub module_type: Option<Box<[u8]>>");
  expect(machineCache).toContain("Str(Box<[u8]>)");
  expect(machineCache).toContain("Obj(Vec<(Box<[u8]>, PackageJsonMachineValue)>)");
  expect(machineCache).toContain("PACKAGE_JSON_READ_ALLOWED_KEYS");
  expect(machineCache).toContain("struct DxMachineCacheStore");
  expect(machineCache).not.toContain("struct PackageJsonPathIndexEntry");
  expect(machineCache).toContain("struct PackageJsonSourceIndexEntry");
  expect(machineCache).toContain("shard_index: u32");
  expect(machineCache).toContain("roots: BTreeMap<PathBuf, Option<PathBuf>>");
  expect(machineCache).toContain("static PROCESS_CACHE");
  expect(machineCache).toContain("fn cached_catalog_for_root(");
  expect(machineCache).toContain("fn package_json_entry_for_path<'a>(");
  expect(machineCache).toContain("node_modules_package_json_name(root, source_path)");
  expect(machineCache).toContain("catalog.package_json_node_modules_index().get(package_name)");
  expect(machineCache).toContain("catalog.package_json_path_index(root).get(source_path)?");
  expect(machineCache).toContain("fn catalog_source_path(root: &Path, source: &str) -> Option<PathBuf>");
  expect(machineCache).toContain("fn cached_shard_for_entry(");
  expect(machineCache).toContain("fn cached_document_for_entry(");
  expect(machineCache).toContain("cached_shard_for_entry(");
  expect(machineCache).toContain("catalog.validate_shard(&path, &shard, entry.shard, entry.key)?;");
  expect(machineCache).toContain("fn read_current_source_validated(");
  expect(machineCache).toContain("fn validate_current_source_metadata(");
  expect(machineCache).toContain("fn blake3_matches_hex(");
  expect(machineCache).toContain("!blake3_matches_hex(source_bytes, entry.source_blake3)");
  expect(machineCache).toContain("!blake3_matches_hex(machine_bytes, expected_blake3)");
  expect(machineCache).not.toContain("blake3_hex(source_bytes)");
  expect(machineCache).not.toContain("fn blake3_hex(");
  expect(machineCache).toContain("[dx-machine-cache] read-through failed");
  expect(machineCache).toContain("bun_core::Output::warn(format_args!");
  expect(machineCache).toContain("[dx-machine-cache] shadow validation failed");
  expect(machineCache).toContain("source_bytes: Option<&[u8]>");
  expect(machineCache).toContain("pub fn package_json_read_path_ref_or_warn");
  expect(machineCache).toContain("fn package_json_read_path_ref_enabled");
  expect(machineCache).toContain("package_json_read_ref_for_key");
  expect(machineCache).toContain("package_json_read_value_ref_owned");
  expect(machineCache).toContain("validate_current_source(&source_path, source_bytes, &entry)");
  expect(machineCache).toContain("let source_bytes = read_current_source_validated(&source_path, &entry)?;");
  const refReadPath = sourceAround(machineCache, "fn package_json_read_path_ref_enabled");
  expect(refReadPath).toContain("let trusted_package_json_snapshot = trusted_package_json_snapshot_for_root(&root);");
  expect(refReadPath).toContain("if trusted_package_json_snapshot");
  expect(refReadPath).toContain("read_current_source_validated(&source_path, &entry)?");
  const fastReadPath = sourceAround(machineCache, "fn package_json_read_path_enabled(");
  expect(fastReadPath).toContain("let trusted_package_json_snapshot = trusted_package_json_snapshot_for_root(&root);");
  expect(fastReadPath).toContain("let trust_source_metadata = trust_source_metadata_enabled();");
  expect(fastReadPath).toContain("if trust_source_metadata");
  expect(fastReadPath).toContain("validate_current_source_metadata(&source_path, &entry)?;");
  expect(fastReadPath).toContain("let use_packed_document = packed_document_read_enabled();");
  expect(fastReadPath).toContain("let trust_package_json_read = trust_package_json_read_enabled();");
  expect(fastReadPath).toContain(
    "packed_package_json_read_enabled()\n        && (source_bytes.is_some() || trusted_package_json_snapshot || trust_package_json_read);",
  );
  expect(fastReadPath).toContain(
    "let shard = if trust_source_metadata && !use_packed_document && !use_packed_package_json",
  );
  expect(fastReadPath).toContain("Some(cached_shard_for_entry(&root, &catalog, &entry)?)");
  expect(fastReadPath).toContain(
    "let shard_entry_count = shard.as_ref().map(|shard| shard.entry_count()).unwrap_or(0);",
  );
  expect(fastReadPath).toContain("shard.package_json_read_for_key(");
  expect(fastReadPath).toContain("entry.package_json_shard_index");
  expect(fastReadPath).toContain("cached_document_for_packed_shard_entry(&root, &entry, shard)?");
  expect(fastReadPath).toContain("source_bytes.as_deref()");
  expect(machineCache).toContain("source byte length mismatch");
  expect(machineCache).toContain("source blake3 mismatch");
  expect(machineCache).toContain("source modified time newer than machine cache");
  expect(machineCache).toContain("map_copy_read_only(&file)");
  expect(machineCache).toContain("fn path_from_utf8_bytes(path: &[u8]) -> Option<&Path>");
  expect(machineCache).toContain("(!text.is_empty()).then(|| Path::new(text))");
  expect(sourceAround(machineCache, "fn repo_relative_source(")).toContain("String::with_capacity");
  expect(sourceAround(machineCache, "fn repo_relative_source(")).toContain("source.push('/')");
  expect(sourceAround(machineCache, "fn repo_relative_source(")).not.toContain("to_string_lossy");
  expect(machineCache).toContain("find_machine_cache_root(&source_path)");
  expect(machineCache).toContain("if let Some(root) = explicit_machine_cache_root(source_path)");
  expect(machineCache).toContain("if let Some(root) = store.last_root.as_ref()");
  expect(machineCache).toContain("fn machine_cache_root_search_anchor(start: &Path) -> PathBuf");
  expect(machineCache).toContain("fn find_machine_cache_root_uncached(mut dir: &Path) -> Option<PathBuf>");
  expect(machineCache).toContain("fn explicit_machine_cache_root(source_path: &Path)");
  expect(machineCache).toContain("fn configured_machine_cache_root()");
  expect(machineCache).toContain("std::env::var_os(CACHE_ROOT_ENV)");
  expect(machineCache).toContain('.join(".dx")');
  expect(machineCache).toContain('.join("js")');
  expect(machineCache).toContain('.join("catalog.machine")');
  expect(machineCache).toContain(".is_file()");
  expect(machineCache).toContain("fn path_contains_node_modules_component(path: &Path) -> bool");
  expect(machineCache).toContain("!path_contains_node_modules_component(dir)");
  expect(machineCache).toContain("let catalog = cached_catalog_for_root(&root)?;");
  expect(machineCache).toContain("package_json_entry_for_path(&root, &source_path, &catalog)");
  expect(machineCache).toContain("let shard = cached_shard_for_entry(&root, &catalog, &entry)?;");
  expect(sourceAround(machineCache, "fn shadow_probe_source_enabled(")).not.toContain("validate_shard");
  expect(sourceAround(machineCache, "fn package_json_read_source_enabled(")).not.toContain("validate_shard");
  expect(sourceAround(machineCache, "fn package_json_read_path_enabled(")).not.toContain("validate_shard");
  expect(machineCache).toContain("let document = cached_document_for_entry(&root, &entry)?;");
  expect(machineCache).toContain("TrustedPackedShardMachine::open(&path)");
  expect(machineCache).toContain("TrustedMachineDocument::open(");
  expect(machineCache).toContain("shard_entry_count: shard.entry_count()");
  expect(machineCache).toContain("key_interning: Option<String>");
  expect(machineCache).toContain("catalog entry key interning path is not repo-relative");
  expect(machineCache).toContain("packed shard key interning path is not repo-relative");
  expect(machineCache).toContain("packed shard path identity mismatch");
  expect(machineCache).toContain("packed shard source byte total mismatch");
  expect(machineCache).toContain("catalog shard entry mismatch");
  expect(machineCache).toContain('matches!(value, "package_json" | "tsconfig" | "bunfig")');
  expect(machineCache).toContain("fn packed_shard_kind_id(kind: &str) -> Option<u32>");
  expect(machineCache).toContain("_ => None");
  expect(machineCache).toContain("document.package_json_summary()");
  expect(machineCache).toContain("document.tsconfig_summary()");
  expect(machineCache).toContain("document.bunfig_summary()");
  expect(packageJson).toContain("crate::dx_machine_cache::read_through_enabled()");
  expect(packageJson).toContain("crate::dx_machine_cache::package_json_path_read_enabled()");
  expect(packageJson).toContain("package_json_read_path_or_warn(");
  expect(packageJson).toContain("package_json_read_path_ref_or_warn(");
  expect(packageJson).toContain('b"" as &\'static [u8]');
  expect(packageJson).toContain("package_json_read_source_or_warn(");
  expect(packageJson).toContain("Self::from_machine_read(");
  expect(packageJson).toContain("Self::from_machine_read_ref(");
  expect(packageJson).toContain("fn exports_map_from_machine_value_ref(");
  expect(packageJson).toContain("fn machine_expansion_keys(");
  expect(packageJson).toContain("MachineEntry");
  expect(packageJson).toContain("EntryData::Machine(MachineEntry {");
  expect(packageJson).toContain("let trusted_resolver_payload = read.trusted_resolver_payload();");
  expect(packageJson).toContain("let expansion_keys = if trusted_resolver_payload");
  expect(packageJson).toContain("expansion_keys,");
  expect(packageJson).toContain("fn expansion_keys(self) -> &'static [u32]");
  expect(packageJson).toContain("fn resolve_machine_imports_exports(");
  expect(packageJson).toContain("EntryData::Machine(machine) => {");
  expect(packageJson).toContain("fn resolve_target_machine<const PATTERN: bool>(");
  expect(packageJson).toContain("fn resolve_target_machine_value<const PATTERN: bool>(");
  expect(packageJson).toContain("fn resolve_simple_machine_string_target(");
  expect(packageJson).toContain("if let Some(result) = self.resolve_simple_machine_string_target(");
  expect(sourceAround(packageJson, "fn resolve_machine_imports_exports(")).toContain(
    "match_obj.value_for_key(match_key)",
  );
  expect(sourceAround(packageJson, "fn resolve_machine_imports_exports(")).toContain(
    "self.resolve_target_machine_value::<false>",
  );
  expect(sourceAround(packageJson, "fn resolve_machine_imports_exports(")).not.toContain(
    "match_obj.entry_for_key(match_key)",
  );
  const simpleMachineStringTarget = sourceAround(
    packageJson,
    "fn resolve_simple_machine_string_target_impl<const PATTERN: bool>(",
  );
  expect(simpleMachineStringTarget).toContain("if internal || self.debug_logs.is_some()");
  expect(simpleMachineStringTarget).not.toContain("internal || !subpath.is_empty() || self.debug_logs.is_some()");
  expect(simpleMachineStringTarget).toContain(
    "if !PATTERN && !subpath.is_empty() && !strings::ends_with_char(str, b'/')",
  );
  expect(simpleMachineStringTarget).toContain(
    "if !subpath.is_empty() && find_invalid_subpath_segment(subpath).is_some()",
  );
  expect(simpleMachineStringTarget).toContain("if PATTERN");
  expect(simpleMachineStringTarget).toContain('replacement_size(resolved_target, b"*", subpath)');
  expect(simpleMachineStringTarget).toContain("Status::ExactEndsWithStar");
  expect(sourceAround(packageJson, "fn resolve_machine_imports_exports(")).toContain("match_obj.expansion_keys()");
  expect(sourceAround(packageJson, "fn resolve_machine_imports_exports(")).toContain(
    "expansion_keys_storage.as_slice()",
  );
  expect(packageJson).toContain('exports.value_for_key(b".")');
  expect(packageJson).toContain("fn entry_from_machine_value_ref(");
  expect(packageJson).toContain("EntryData::String(EntryString::Source(value.as_static_str()?))");
  expect(packageJson).toContain("let (key, value) = value.object_field_static(index)?;");
  expect(packageJson).toContain("key: EntryString::Source(key)");
  const fromMachineRead = sourceAround(packageJson, "fn from_machine_read(");
  expect(fromMachineRead).toContain(
    "fn from_machine_read(\n        read: crate::dx_machine_cache::PackageJsonMachineRead",
  );
  expect(packageJson).toContain("name: read.name.unwrap_or_default()");
  expect(packageJson).toContain("version: read.version.unwrap_or_default()");
  expect(packageJson).toContain("EntryData::String(EntryString::Owned(value))");
  expect(packageJson).toContain("for (index, (key, value)) in fields.into_iter().enumerate()");
  expect(packageJson).toContain("key: EntryString::Owned(key)");
  expect(packageJson).toContain("EntryData::Map(EntryDataMap::new(");

  expect(packageJson).toContain("DxMachineCacheKind::PackageJson");
  expect(packageJson).toContain("if crate::dx_machine_cache::shadow_probe_enabled()");
  expect(packageJson).toContain("shadow_probe_source_or_warn(");
  expect(packageJson).toContain("&entry_contents");
  expect(packageJsonProbe).not.toContain(".ok()");
  expect(packageJsonProbe).not.toContain(".flatten()");
  expect(tsconfig).toContain("DxMachineCacheKind::Tsconfig");
  expect(tsconfig).toContain("if crate::dx_machine_cache::shadow_probe_enabled()");
  expect(tsconfig).toContain("shadow_probe_source_or_warn(");
  expect(tsconfig).toContain("source.contents()");
  expect(tsconfigProbe).not.toContain(".ok()");
  expect(tsconfigProbe).not.toContain(".flatten()");
  expect(bunfig).toContain("DxMachineCacheKind::Bunfig");
  expect(bunfig).toContain("if bun_resolver::dx_machine_cache::shadow_probe_enabled()");
  expect(bunfig).toContain("shadow_probe_source_or_warn(");
  expect(bunfig).toContain("source.contents()");
  expect(bunfigProbe).not.toContain(".ok()");
  expect(bunfigProbe).not.toContain(".flatten()");
});

test("marks dx-generated package-json resolver snapshots as trusted", () => {
  const script = readRepoFile("scripts/dx-js-machine-cache.ps1");

  expect(script).toContain("package-json-read.trusted");
  expect(script).toContain("dx.js.machine_cache_package_json_read_trust.v1");
  expect(script).toContain("trustedPackageJsonSnapshotPath");
});
