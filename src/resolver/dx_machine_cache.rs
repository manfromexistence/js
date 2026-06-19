#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use memmap2::{Mmap, MmapOptions};
use rkyv::Archive;
use sha2::{Digest, Sha256};

type FastHashMap<K, V> = HashMap<K, V, bun_wyhash::BuildHasher>;

const CATALOG_MACHINE_SCHEMA: &str = "dx.js.machine_cache_catalog.machine.rkyv_hashbrown.v1";
const SHARD_MACHINE_SCHEMA: &str = "dx.js.machine_cache_packed_shard.rkyv.v1";
const SHARD_MACHINE_SCHEMA_V2: &str = "dx.js.machine_cache_packed_shard.rkyv_documents.v2";
const SHARD_MACHINE_SCHEMA_V3: &str = "dx.js.machine_cache_packed_shard.rkyv_package_json_read.v3";
const SHARD_MACHINE_SCHEMA_V4: &str =
    "dx.js.machine_cache_packed_shard.rkyv_package_json_read_identity.v4";
const SHARD_MACHINE_SCHEMA_V5: &str =
    "dx.js.machine_cache_packed_shard.rkyv_package_json_resolver_read_identity.v5";
const MACHINE_ENVELOPE_MAGIC: [u8; 4] = *b"DXM1";
const MACHINE_ENVELOPE_VERSION: u8 = 1;
const MACHINE_ENVELOPE_HEADER_LEN: usize = 56;
const MACHINE_ENVELOPE_CODEC_NONE: u8 = 0;
const SHARD_MAGIC: [u8; 8] = *b"DXJSHARD";
const SHARD_HEADER_BYTES: usize = 160;
const PACKED_SHARD_STORE_ROOT: &str = ".dx/js/shards";
const SHADOW_ENV: &str = "BUN_DX_MACHINE_CACHE_SHADOW";
const READ_ENV: &str = "BUN_DX_MACHINE_CACHE_READ";
const FAST_READ_ENV: &str = "BUN_DX_MACHINE_CACHE_READ_FAST";
const DISABLE_ENV: &str = "BUN_DX_MACHINE_CACHE_DISABLE";
const CACHE_ROOT_ENV: &str = "BUN_DX_MACHINE_CACHE_ROOT";
const TRUST_DOCUMENT_ENV: &str = "BUN_DX_MACHINE_CACHE_TRUST_DOCUMENT";
const TRUST_SOURCE_METADATA_ENV: &str = "BUN_DX_MACHINE_CACHE_TRUST_SOURCE_METADATA";
const TRUST_PACKAGE_JSON_READ_ENV: &str = "BUN_DX_MACHINE_CACHE_TRUST_PACKAGE_JSON_READ";
const TRUSTED_PACKAGE_JSON_SNAPSHOT_MARKER: &str = "package-json-read.trusted";
const BUFFER_DOCUMENTS_ENV: &str = "BUN_DX_MACHINE_CACHE_BUFFER_DOCUMENTS";
const PACKED_DOCUMENT_READ_ENV: &str = "BUN_DX_MACHINE_CACHE_READ_PACKED_DOCUMENTS";
const PACKED_PACKAGE_JSON_READ_ENV: &str = "BUN_DX_MACHINE_CACHE_READ_PACKED_PACKAGE_JSON";
const PROOF_LOG_ENV: &str = "BUN_DX_MACHINE_CACHE_PROOF_LOG";
const PACKAGE_JSON_READ_ALLOWED_KEYS: &[&str] = &[
    "name",
    "version",
    "type",
    "main",
    "module",
    "browser",
    "jsnext:main",
    "sideEffects",
    "exports",
    "imports",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DxMachineCacheKind {
    PackageJson,
    Tsconfig,
    Bunfig,
}

impl DxMachineCacheKind {
    #[inline]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PackageJson => "package_json",
            Self::Tsconfig => "tsconfig",
            Self::Bunfig => "bunfig",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DxMachineCacheError {
    #[error("open {path}: {source}")]
    Open {
        path: String,
        source: std::io::Error,
    },
    #[error("mmap {path}: {source}")]
    Mmap {
        path: String,
        source: std::io::Error,
    },
    #[error("invalid {path}: {reason}")]
    Invalid { path: String, reason: &'static str },
    #[error("bytecheck {path}: {source}")]
    Bytecheck {
        path: String,
        source: rkyv::rancor::Error,
    },
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
struct JsCacheCatalogMachine {
    schema: String,
    generated_at_utc: String,
    shards: Vec<String>,
    lookup: Vec<JsCacheCatalogLookup>,
    entries: Vec<JsCacheCatalogEntryMachine>,
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
struct JsCacheCatalogLookup {
    key: String,
    index: u32,
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
struct JsCacheCatalogEntryMachine {
    key: String,
    kind: String,
    source: String,
    shard: String,
    machine: String,
    metadata: String,
    key_interning: Option<String>,
    source_bytes: u64,
    source_modified_unix_ms: Option<u64>,
    source_blake3: String,
    machine_blake3: String,
    machine_bytes: u64,
    metadata_bytes: u64,
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
struct JsCacheShardMachine {
    schema: String,
    shard: String,
    entries: Vec<JsCacheShardEntryMachine>,
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
struct JsCacheShardEntryMachine {
    key: String,
    source: String,
    machine: String,
    metadata: String,
    key_interning: Option<String>,
    source_blake3: String,
    machine_blake3: String,
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
struct JsCacheShardMachineV2 {
    schema: String,
    shard: String,
    entries: Vec<JsCacheShardEntryMachineV2>,
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
struct JsCacheShardEntryMachineV2 {
    key: String,
    source: String,
    machine: String,
    metadata: String,
    key_interning: Option<String>,
    source_blake3: String,
    machine_blake3: String,
    machine_document: Option<Vec<u8>>,
}

#[derive(Archive, Debug)]
#[cfg_attr(test, derive(rkyv::Serialize))]
#[rkyv(derive(Debug))]
struct JsCacheShardMachineV3 {
    schema: String,
    shard: String,
    entries: Vec<JsCacheShardEntryMachineV3>,
}

#[derive(Archive, Debug)]
#[cfg_attr(test, derive(rkyv::Serialize))]
#[rkyv(derive(Debug))]
struct JsCacheShardEntryMachineV3 {
    key: String,
    source: String,
    machine: String,
    metadata: String,
    key_interning: Option<String>,
    source_blake3: String,
    machine_blake3: String,
    machine_document: Option<Vec<u8>>,
    package_json_read: Option<PackageJsonReadMachineV4>,
}

#[derive(Archive, Debug)]
#[cfg_attr(test, derive(rkyv::Serialize))]
#[rkyv(derive(Debug))]
struct JsCacheShardMachineV5 {
    schema: String,
    shard: String,
    entries: Vec<JsCacheShardEntryMachineV5>,
}

#[derive(Archive, Debug)]
#[cfg_attr(test, derive(rkyv::Serialize))]
#[rkyv(derive(Debug))]
struct JsCacheShardEntryMachineV5 {
    key: String,
    source: String,
    machine: String,
    metadata: String,
    key_interning: Option<String>,
    source_blake3: String,
    machine_blake3: String,
    machine_document: Option<Vec<u8>>,
    package_json_read: Option<PackageJsonReadMachine>,
}

#[derive(Archive, Debug)]
#[cfg_attr(test, derive(rkyv::Serialize))]
#[rkyv(derive(Debug))]
struct PackageJsonReadMachineV4 {
    name: Option<String>,
    version: Option<String>,
    module_type: Option<String>,
    exports: Option<usize>,
    imports: Option<usize>,
    value_arena: Vec<PackageJsonReadMachineValue>,
}

#[derive(Archive, Debug)]
#[cfg_attr(test, derive(rkyv::Serialize))]
#[rkyv(derive(Debug))]
struct PackageJsonReadMachine {
    name: Option<String>,
    version: Option<String>,
    module_type: Option<String>,
    main: Option<String>,
    module: Option<String>,
    browser: Option<usize>,
    jsnext_main: Option<String>,
    side_effects: Option<usize>,
    exports: Option<usize>,
    imports: Option<usize>,
    value_arena: Vec<PackageJsonReadMachineValue>,
}

#[derive(Archive, Debug)]
#[cfg_attr(test, derive(rkyv::Serialize))]
#[rkyv(derive(Debug))]
enum PackageJsonReadMachineValue {
    Str(String),
    Bool(bool),
    Null,
    Arr(Vec<usize>),
    Obj(Vec<(String, usize)>),
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
struct DxMachineDocument {
    context: Vec<(String, usize)>,
    refs: Vec<(String, String)>,
    sections: Vec<(char, DxMachineSection)>,
    section_names: Vec<(char, String)>,
    entry_order: Vec<DxMachineEntryRef>,
    value_arena: Vec<DxMachineValue>,
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
enum DxMachineEntryRef {
    Context(String),
    Section(char),
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
struct DxMachineSection {
    schema: Vec<String>,
    rows: Vec<Vec<usize>>,
}

#[derive(Archive, Debug)]
#[rkyv(derive(Debug))]
enum DxMachineValue {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
    Arr(Vec<usize>),
    Obj(Vec<(String, usize)>),
    Ref(String),
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct DxJsMachineCachePackedShardHeader {
    pub magic: [u8; 8],
    pub version: u32,
    pub header_bytes: u32,
    pub kind_id: u32,
    pub entry_count: u32,
    pub source_bytes: u64,
    pub machine_bytes: u64,
    pub metadata_bytes: u64,
    pub shard_path_blake3: [u8; 32],
    pub source_identity_blake3: [u8; 32],
    pub machine_identity_blake3: [u8; 32],
    pub reserved: [u8; 16],
}

pub struct TrustedMachineFile {
    backing: TrustedMachineDocumentBacking,
}

enum TrustedMachineDocumentBacking {
    Mmap(Mmap),
    Bytes(Box<[u8]>),
}

impl TrustedMachineDocumentBacking {
    #[inline]
    fn bytes(&self) -> &[u8] {
        match self {
            Self::Mmap(mmap) => mmap,
            Self::Bytes(bytes) => bytes,
        }
    }

    #[inline]
    fn len(&self) -> usize {
        self.bytes().len()
    }
}

#[derive(Clone, Copy)]
enum MachineDocumentIntegrity {
    FullFileHash,
    EnvelopePayload,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DxMachineShadowProbe {
    pub kind: DxMachineCacheKind,
    pub source: Box<str>,
    pub machine: Box<str>,
    pub mapped_bytes: usize,
    pub context_key_count: usize,
    pub shard_entry_count: usize,
}

pub struct PackageJsonMachineRead {
    pub name: Option<Box<[u8]>>,
    pub version: Option<Box<[u8]>>,
    pub module_type: Option<Box<[u8]>>,
    pub main: Option<Box<[u8]>>,
    pub module: Option<Box<[u8]>>,
    pub browser: Option<PackageJsonMachineValue>,
    pub jsnext_main: Option<Box<[u8]>>,
    pub side_effects: Option<PackageJsonMachineValue>,
    pub exports: Option<PackageJsonMachineValue>,
    pub imports: Option<PackageJsonMachineValue>,
    pub mapped_bytes: usize,
    pub context_key_count: usize,
    pub shard_entry_count: usize,
}

pub enum PackageJsonMachineValue {
    Str(Box<[u8]>),
    Bool(bool),
    Null,
    Arr(Vec<PackageJsonMachineValue>),
    Obj(Vec<(Box<[u8]>, PackageJsonMachineValue)>),
}

#[derive(Clone, Copy)]
pub struct PackageJsonMachineReadRef<'a> {
    read: &'a ArchivedPackageJsonReadMachine,
    mapped_bytes: usize,
    shard_entry_count: usize,
    trusted_resolver_payload: bool,
}

#[derive(Clone, Copy)]
pub struct PackageJsonMachineValueRef<'a> {
    read: &'a ArchivedPackageJsonReadMachine,
    value: &'a ArchivedPackageJsonReadMachineValue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageJsonMachineValueKind {
    Str,
    Bool,
    Null,
    Arr,
    Obj,
}

impl<'a> PackageJsonMachineReadRef<'a> {
    #[inline]
    pub fn name(self) -> Option<&'a [u8]> {
        self.read
            .name
            .as_ref()
            .map(|value| value.as_str().as_bytes())
    }

    #[inline]
    pub fn version(self) -> Option<&'a [u8]> {
        self.read
            .version
            .as_ref()
            .map(|value| value.as_str().as_bytes())
    }

    #[inline]
    pub fn module_type(self) -> Option<&'a [u8]> {
        self.read
            .module_type
            .as_ref()
            .map(|value| value.as_str().as_bytes())
    }

    #[inline]
    pub fn main(self) -> Option<&'a [u8]> {
        self.read
            .main
            .as_ref()
            .map(|value| value.as_str().as_bytes())
    }

    #[inline]
    pub fn module(self) -> Option<&'a [u8]> {
        self.read
            .module
            .as_ref()
            .map(|value| value.as_str().as_bytes())
    }

    #[inline]
    pub fn browser(self) -> Option<PackageJsonMachineValueRef<'a>> {
        self.read
            .browser
            .as_ref()
            .and_then(|index| usize::try_from(*index).ok())
            .and_then(|index| self.value_at(index))
    }

    #[inline]
    pub fn jsnext_main(self) -> Option<&'a [u8]> {
        self.read
            .jsnext_main
            .as_ref()
            .map(|value| value.as_str().as_bytes())
    }

    #[inline]
    pub fn side_effects(self) -> Option<PackageJsonMachineValueRef<'a>> {
        self.read
            .side_effects
            .as_ref()
            .and_then(|index| usize::try_from(*index).ok())
            .and_then(|index| self.value_at(index))
    }

    #[inline]
    pub fn exports(self) -> Option<PackageJsonMachineValueRef<'a>> {
        self.read
            .exports
            .as_ref()
            .and_then(|index| usize::try_from(*index).ok())
            .and_then(|index| self.value_at(index))
    }

    #[inline]
    pub fn imports(self) -> Option<PackageJsonMachineValueRef<'a>> {
        self.read
            .imports
            .as_ref()
            .and_then(|index| usize::try_from(*index).ok())
            .and_then(|index| self.value_at(index))
    }

    #[inline]
    pub fn mapped_bytes(self) -> usize {
        self.mapped_bytes
    }

    #[inline]
    pub fn context_key_count(self) -> usize {
        package_json_read_key_count(self.read)
    }

    #[inline]
    pub fn shard_entry_count(self) -> usize {
        self.shard_entry_count
    }

    #[inline]
    pub fn trusted_resolver_payload(self) -> bool {
        self.trusted_resolver_payload
    }

    #[inline]
    fn value_at(self, index: usize) -> Option<PackageJsonMachineValueRef<'a>> {
        self.read
            .value_arena
            .get(index)
            .map(|value| PackageJsonMachineValueRef {
                read: self.read,
                value,
            })
    }
}

impl<'a> PackageJsonMachineValueRef<'a> {
    #[inline]
    pub fn into_static(self) -> PackageJsonMachineValueRef<'static> {
        // SAFETY: direct package-json reads are produced from a
        // TrustedPackedShardMachine stored in the process-wide machine cache.
        // The cache never evicts shards during resolver lifetime, so archived
        // value references remain valid for every PackageJSON that stores them.
        PackageJsonMachineValueRef {
            read: unsafe { bun_ptr::detach_lifetime_ref(self.read) },
            value: unsafe { bun_ptr::detach_lifetime_ref(self.value) },
        }
    }

    #[inline]
    pub fn kind(self) -> PackageJsonMachineValueKind {
        match self.value {
            ArchivedPackageJsonReadMachineValue::Str(_) => PackageJsonMachineValueKind::Str,
            ArchivedPackageJsonReadMachineValue::Bool(_) => PackageJsonMachineValueKind::Bool,
            ArchivedPackageJsonReadMachineValue::Null => PackageJsonMachineValueKind::Null,
            ArchivedPackageJsonReadMachineValue::Arr(_) => PackageJsonMachineValueKind::Arr,
            ArchivedPackageJsonReadMachineValue::Obj(_) => PackageJsonMachineValueKind::Obj,
        }
    }

    #[inline]
    pub fn as_str(self) -> Option<&'a [u8]> {
        match self.value {
            ArchivedPackageJsonReadMachineValue::Str(value) => Some(value.as_str().as_bytes()),
            _ => None,
        }
    }

    #[inline]
    pub fn as_static_str(self) -> Option<&'static [u8]> {
        let bytes = self.as_str()?;
        // SAFETY: direct package-json reads come from a TrustedPackedShardMachine
        // stored in the process-wide machine cache. That cache never evicts
        // shards during resolver lifetime, so archived string bytes outlive
        // every interned PackageJSON that stores EntryString::Source.
        Some(unsafe { bun_ptr::detach_lifetime(bytes) })
    }

    #[inline]
    pub fn as_bool(self) -> Option<bool> {
        match self.value {
            ArchivedPackageJsonReadMachineValue::Bool(value) => Some(*value),
            _ => None,
        }
    }

    #[inline]
    pub fn array_len(self) -> Option<usize> {
        match self.value {
            ArchivedPackageJsonReadMachineValue::Arr(items) => Some(items.len()),
            _ => None,
        }
    }

    #[inline]
    pub fn array_item(self, index: usize) -> Option<PackageJsonMachineValueRef<'a>> {
        let ArchivedPackageJsonReadMachineValue::Arr(items) = self.value else {
            return None;
        };
        let index = usize::try_from(*items.get(index)?).ok()?;
        self.value_at(index)
    }

    #[inline]
    pub fn object_len(self) -> Option<usize> {
        match self.value {
            ArchivedPackageJsonReadMachineValue::Obj(fields) => Some(fields.len()),
            _ => None,
        }
    }

    #[inline]
    pub fn object_field(self, index: usize) -> Option<(&'a [u8], PackageJsonMachineValueRef<'a>)> {
        let ArchivedPackageJsonReadMachineValue::Obj(fields) = self.value else {
            return None;
        };
        let entry = fields.get(index)?;
        let value_index = usize::try_from(entry.1).ok()?;
        Some((entry.0.as_str().as_bytes(), self.value_at(value_index)?))
    }

    #[inline]
    pub fn object_field_static(
        self,
        index: usize,
    ) -> Option<(&'static [u8], PackageJsonMachineValueRef<'a>)> {
        let (key, value) = self.object_field(index)?;
        // SAFETY: see as_static_str(); object keys borrow from the same cached
        // packed shard mmap as archived string values.
        Some((unsafe { bun_ptr::detach_lifetime(key) }, value))
    }

    #[inline]
    pub fn object_value_for_key_static(
        self,
        key: &[u8],
    ) -> Option<PackageJsonMachineValueRef<'static>> {
        let len = self.object_len()?;
        for index in 0..len {
            let (field_key, value) = self.object_field_static(index)?;
            if field_key == key {
                return Some(value.into_static());
            }
        }
        None
    }

    #[inline]
    fn value_at(self, index: usize) -> Option<PackageJsonMachineValueRef<'a>> {
        self.read
            .value_arena
            .get(index)
            .map(|value| PackageJsonMachineValueRef {
                read: self.read,
                value,
            })
    }
}

struct DxMachineCacheStore {
    catalogs: BTreeMap<PathBuf, Arc<TrustedCatalogMachine>>,
    shards: BTreeMap<PathBuf, Arc<TrustedPackedShardMachine>>,
    documents: BTreeMap<MachineDocumentCacheKey, Arc<TrustedMachineDocument>>,
    roots: BTreeMap<PathBuf, Option<PathBuf>>,
    trusted_package_json_snapshots: BTreeMap<PathBuf, bool>,
    last_root: Option<PathBuf>,
}

struct ActivePackageJsonMachineCache {
    root: PathBuf,
    catalog: Arc<TrustedCatalogMachine>,
    trusted_package_json_snapshot: bool,
    package_json_shard: OnceLock<ActivePackageJsonShard>,
}

struct ActivePackageJsonShard {
    name: Box<str>,
    shard: Arc<TrustedPackedShardMachine>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct MachineDocumentCacheKey {
    path: PathBuf,
    expected_bytes: u64,
    expected_blake3: Box<str>,
}

static PROCESS_CACHE: OnceLock<Mutex<DxMachineCacheStore>> = OnceLock::new();
static ACTIVE_PACKAGE_JSON_CACHE: OnceLock<Option<ActivePackageJsonMachineCache>> = OnceLock::new();

impl DxMachineCacheStore {
    fn new() -> Self {
        Self {
            catalogs: BTreeMap::new(),
            shards: BTreeMap::new(),
            documents: BTreeMap::new(),
            roots: BTreeMap::new(),
            trusted_package_json_snapshots: BTreeMap::new(),
            last_root: None,
        }
    }
}

impl TrustedMachineFile {
    fn open(
        path: &Path,
        expected_bytes: u64,
        expected_blake3: &str,
        integrity: MachineDocumentIntegrity,
    ) -> Result<Self, DxMachineCacheError> {
        let backing = read_machine_file(path)?;
        Self::from_backing(path, backing, expected_bytes, expected_blake3, integrity)
    }

    fn from_bytes(
        path: &Path,
        bytes: Box<[u8]>,
        expected_bytes: u64,
        expected_blake3: &str,
        integrity: MachineDocumentIntegrity,
    ) -> Result<Self, DxMachineCacheError> {
        Self::from_backing(
            path,
            TrustedMachineDocumentBacking::Bytes(bytes),
            expected_bytes,
            expected_blake3,
            integrity,
        )
    }

    fn from_backing(
        path: &Path,
        backing: TrustedMachineDocumentBacking,
        expected_bytes: u64,
        expected_blake3: &str,
        integrity: MachineDocumentIntegrity,
    ) -> Result<Self, DxMachineCacheError> {
        let machine_bytes = backing.bytes();
        if machine_bytes.len() as u64 != expected_bytes {
            return Err(invalid(path, "machine byte length mismatch"));
        }
        match integrity {
            MachineDocumentIntegrity::FullFileHash => {
                if !blake3_matches_hex(machine_bytes, expected_blake3) {
                    return Err(invalid(path, "machine blake3 mismatch"));
                }
            }
            MachineDocumentIntegrity::EnvelopePayload => {}
        }
        Ok(Self { backing })
    }

    #[inline]
    pub fn bytes(&self) -> &[u8] {
        self.backing.bytes()
    }
}

pub struct TrustedMachineDocument {
    backing: TrustedMachineDocumentBacking,
    payload_offset: usize,
    payload_len: usize,
}

impl TrustedMachineDocument {
    pub fn open(
        path: &Path,
        expected_bytes: u64,
        expected_blake3: &str,
    ) -> Result<Self, DxMachineCacheError> {
        let trusted_file = TrustedMachineFile::open(
            path,
            expected_bytes,
            expected_blake3,
            machine_document_integrity(),
        )?;
        Self::from_trusted_file(path, trusted_file)
    }

    pub fn from_bytes(
        path: &Path,
        bytes: Box<[u8]>,
        expected_bytes: u64,
        expected_blake3: &str,
    ) -> Result<Self, DxMachineCacheError> {
        let trusted_file = TrustedMachineFile::from_bytes(
            path,
            bytes,
            expected_bytes,
            expected_blake3,
            machine_document_integrity(),
        )?;
        Self::from_trusted_file(path, trusted_file)
    }

    pub fn from_trusted_file(
        path: &Path,
        trusted_file: TrustedMachineFile,
    ) -> Result<Self, DxMachineCacheError> {
        let (payload_offset, payload_len) =
            decode_machine_envelope_payload_bounds(path, trusted_file.bytes())?;

        Ok(Self {
            backing: trusted_file.backing,
            payload_offset,
            payload_len,
        })
    }

    #[inline]
    pub fn mapped_bytes(&self) -> usize {
        self.backing.len()
    }

    #[inline]
    pub fn context_key_count(&self) -> usize {
        self.archived().context.len()
    }

    pub fn package_json_summary(&self) -> PackageJsonMachineSummary<'_> {
        PackageJsonMachineSummary {
            name: self.context_str("name"),
            version: self.context_str("version"),
            module_type: self.context_str("type"),
            has_exports: self.context_value("exports").is_some(),
            has_imports: self.context_value("imports").is_some(),
            has_scripts: self.context_value("scripts").is_some(),
            dependency_count: self.context_object_len("dependencies"),
            dev_dependency_count: self.context_object_len("devDependencies"),
            optional_dependency_count: self.context_object_len("optionalDependencies"),
            peer_dependency_count: self.context_object_len("peerDependencies"),
        }
    }

    pub fn package_json_read(
        &self,
        shard_entry_count: usize,
        source_bytes: Option<&[u8]>,
    ) -> Option<PackageJsonMachineRead> {
        if let Some(source_bytes) = source_bytes {
            if package_json_source_has_unsupported_read_keys(source_bytes) {
                return None;
            }
        }

        let document = self.archived();
        for entry in document.context.iter() {
            if !PACKAGE_JSON_READ_ALLOWED_KEYS.contains(&entry.0.as_str()) {
                return None;
            }
        }

        Some(PackageJsonMachineRead {
            name: self
                .context_str("name")
                .map(|value| Box::<[u8]>::from(value.as_bytes())),
            version: self
                .context_str("version")
                .map(|value| Box::<[u8]>::from(value.as_bytes())),
            module_type: self
                .context_str("type")
                .map(|value| Box::<[u8]>::from(value.as_bytes())),
            main: self
                .context_str("main")
                .map(|value| Box::<[u8]>::from(value.as_bytes())),
            module: self
                .context_str("module")
                .map(|value| Box::<[u8]>::from(value.as_bytes())),
            browser: self
                .context_value("browser")
                .and_then(|value| self.owned_package_json_value(value)),
            jsnext_main: self
                .context_str("jsnext:main")
                .map(|value| Box::<[u8]>::from(value.as_bytes())),
            side_effects: self
                .context_value("sideEffects")
                .and_then(|value| self.owned_package_json_value(value)),
            exports: self
                .context_value("exports")
                .and_then(|value| self.owned_package_json_value(value)),
            imports: self
                .context_value("imports")
                .and_then(|value| self.owned_package_json_value(value)),
            mapped_bytes: self.mapped_bytes(),
            context_key_count: self.context_key_count(),
            shard_entry_count,
        })
    }

    pub fn tsconfig_summary(&self) -> TsconfigMachineSummary<'_> {
        let compiler_options = self.context_value("compilerOptions");
        let paths = compiler_options.and_then(|value| self.value_object_field(value, "paths"));

        TsconfigMachineSummary {
            extends: self.context_str("extends"),
            has_compiler_options: compiler_options.is_some(),
            base_url: compiler_options.and_then(|value| self.value_object_str(value, "baseUrl")),
            jsx: compiler_options.and_then(|value| self.value_object_str(value, "jsx")),
            jsx_factory: compiler_options
                .and_then(|value| self.value_object_str(value, "jsxFactory")),
            jsx_fragment_factory: compiler_options
                .and_then(|value| self.value_object_str(value, "jsxFragmentFactory")),
            jsx_import_source: compiler_options
                .and_then(|value| self.value_object_str(value, "jsxImportSource")),
            use_define_for_class_fields: compiler_options
                .and_then(|value| self.value_object_bool(value, "useDefineForClassFields")),
            has_paths: paths.is_some(),
            paths_pattern_count: paths.map(Self::value_object_len).unwrap_or(0),
            include_count: self.context_array_len("include"),
            exclude_count: self.context_array_len("exclude"),
            references_count: self.context_array_len("references"),
        }
    }

    pub fn bunfig_summary(&self) -> BunfigMachineSummary<'_> {
        let define = self.context_value("define");
        let test = self.context_value("test");
        let install = self.context_value("install");
        let install_scopes = install.and_then(|value| self.value_object_field(value, "scopes"));
        let serve = self.context_value("serve");

        BunfigMachineSummary {
            jsx: self.context_str("jsx"),
            jsx_factory: self.context_str("jsxFactory"),
            jsx_fragment: self.context_str("jsxFragment"),
            jsx_import_source: self.context_str("jsxImportSource"),
            telemetry: self.context_bool("telemetry"),
            has_define: define.is_some(),
            define_count: define.map(Self::value_object_len).unwrap_or(0),
            has_test: test.is_some(),
            test_key_count: test.map(Self::value_object_len).unwrap_or(0),
            has_install: install.is_some(),
            install_key_count: install.map(Self::value_object_len).unwrap_or(0),
            install_scopes_count: install_scopes.map(Self::value_object_len).unwrap_or(0),
            has_serve: serve.is_some(),
            serve_key_count: serve.map(Self::value_object_len).unwrap_or(0),
        }
    }

    #[inline]
    fn payload(&self) -> &[u8] {
        &self.backing.bytes()[self.payload_offset..self.payload_offset + self.payload_len]
    }

    #[inline]
    fn archived(&self) -> &ArchivedDxMachineDocument {
        unsafe { rkyv::access_unchecked::<ArchivedDxMachineDocument>(self.payload()) }
    }

    fn context_str(&self, key: &str) -> Option<&str> {
        Self::value_as_str(self.context_value(key)?)
    }

    fn context_bool(&self, key: &str) -> Option<bool> {
        Self::value_as_bool(self.context_value(key)?)
    }

    fn context_object_len(&self, key: &str) -> usize {
        self.context_value(key)
            .map(Self::value_object_len)
            .unwrap_or(0)
    }

    fn context_array_len(&self, key: &str) -> usize {
        self.context_value(key)
            .map(Self::value_array_len)
            .unwrap_or(0)
    }

    fn context_value(&self, key: &str) -> Option<&ArchivedDxMachineValue> {
        let document = self.archived();
        document.context.iter().find_map(|entry| {
            (entry.0.as_str() == key)
                .then(|| self.value_at(entry.1.to_native() as usize))
                .flatten()
        })
    }

    fn value_at(&self, index: usize) -> Option<&ArchivedDxMachineValue> {
        self.archived().value_arena.get(index)
    }

    fn value_object_field<'a>(
        &'a self,
        value: &'a ArchivedDxMachineValue,
        key: &str,
    ) -> Option<&'a ArchivedDxMachineValue> {
        let ArchivedDxMachineValue::Obj(fields) = value else {
            return None;
        };

        fields.iter().find_map(|entry| {
            (entry.0.as_str() == key)
                .then(|| self.value_at(entry.1.to_native() as usize))
                .flatten()
        })
    }

    fn value_object_str<'a>(
        &'a self,
        value: &'a ArchivedDxMachineValue,
        key: &str,
    ) -> Option<&'a str> {
        Self::value_as_str(self.value_object_field(value, key)?)
    }

    fn value_object_bool(&self, value: &ArchivedDxMachineValue, key: &str) -> Option<bool> {
        Self::value_as_bool(self.value_object_field(value, key)?)
    }

    fn value_as_str(value: &ArchivedDxMachineValue) -> Option<&str> {
        match value {
            ArchivedDxMachineValue::Str(value) => Some(value.as_str()),
            _ => None,
        }
    }

    fn value_as_bool(value: &ArchivedDxMachineValue) -> Option<bool> {
        match value {
            ArchivedDxMachineValue::Bool(value) => Some(*value),
            _ => None,
        }
    }

    fn value_object_len(value: &ArchivedDxMachineValue) -> usize {
        match value {
            ArchivedDxMachineValue::Obj(fields) => fields.len(),
            _ => 0,
        }
    }

    fn value_array_len(value: &ArchivedDxMachineValue) -> usize {
        match value {
            ArchivedDxMachineValue::Arr(items) => items.len(),
            _ => 0,
        }
    }

    fn owned_package_json_value(
        &self,
        value: &ArchivedDxMachineValue,
    ) -> Option<PackageJsonMachineValue> {
        match value {
            ArchivedDxMachineValue::Str(value) => Some(PackageJsonMachineValue::Str(Box::from(
                value.as_str().as_bytes(),
            ))),
            ArchivedDxMachineValue::Bool(value) => Some(PackageJsonMachineValue::Bool(*value)),
            ArchivedDxMachineValue::Null => Some(PackageJsonMachineValue::Null),
            ArchivedDxMachineValue::Arr(items) => {
                let mut output = Vec::with_capacity(items.len());
                for index in items.iter() {
                    let index = usize::try_from(*index).ok()?;
                    output.push(self.owned_package_json_value(self.value_at(index)?)?);
                }
                Some(PackageJsonMachineValue::Arr(output))
            }
            ArchivedDxMachineValue::Obj(fields) => {
                let mut output = Vec::with_capacity(fields.len());
                for entry in fields.iter() {
                    let index = usize::try_from(entry.1).ok()?;
                    output.push((
                        Box::<[u8]>::from(entry.0.as_str().as_bytes()),
                        self.owned_package_json_value(self.value_at(index)?)?,
                    ));
                }
                Some(PackageJsonMachineValue::Obj(output))
            }
            ArchivedDxMachineValue::Num(_) | ArchivedDxMachineValue::Ref(_) => None,
        }
    }
}

pub fn shadow_probe_source(
    kind: DxMachineCacheKind,
    source_path: &[u8],
    source_bytes: &[u8],
) -> Result<Option<DxMachineShadowProbe>, DxMachineCacheError> {
    if !shadow_probe_enabled() {
        return Ok(None);
    }

    shadow_probe_source_enabled(kind, source_path, source_bytes)
}

pub fn shadow_probe_source_or_warn(
    kind: DxMachineCacheKind,
    source_path: &[u8],
    source_bytes: &[u8],
) -> Option<DxMachineShadowProbe> {
    match shadow_probe_source(kind, source_path, source_bytes) {
        Ok(probe) => probe,
        Err(err) => {
            warn_shadow_probe_error(kind, source_path, err);
            None
        }
    }
}

pub fn package_json_read_source_or_warn(
    source_path: &[u8],
    source_bytes: &[u8],
) -> Option<PackageJsonMachineRead> {
    if !read_through_enabled() {
        return None;
    }

    match package_json_read_source_enabled(source_path, source_bytes) {
        Ok(read) => read,
        Err(err) => {
            warn_read_through_error(DxMachineCacheKind::PackageJson, source_path, err);
            None
        }
    }
}

pub fn package_json_read_path_or_warn(source_path: &[u8]) -> Option<PackageJsonMachineRead> {
    if !package_json_path_read_enabled() {
        return None;
    }

    match package_json_read_path_enabled(source_path) {
        Ok(read) => {
            record_package_json_machine_cache_proof(
                if read.is_some() {
                    "path_owned_read_some"
                } else {
                    "path_owned_read_none"
                },
                source_path,
            );
            read
        }
        Err(err) => {
            record_package_json_machine_cache_proof("path_owned_read_error", source_path);
            warn_read_through_error(DxMachineCacheKind::PackageJson, source_path, err);
            None
        }
    }
}

pub fn package_json_read_path_ref_or_warn<T>(
    source_path: &[u8],
    convert: impl FnOnce(PackageJsonMachineReadRef<'_>) -> Option<T>,
) -> Option<T> {
    if !package_json_path_read_enabled() {
        return None;
    }

    match package_json_read_path_ref_enabled(source_path, convert) {
        Ok(read) => {
            record_package_json_machine_cache_proof(
                if read.is_some() {
                    "path_ref_read_some"
                } else {
                    "path_ref_read_none"
                },
                source_path,
            );
            read
        }
        Err(err) => {
            record_package_json_machine_cache_proof("path_ref_read_error", source_path);
            warn_read_through_error(DxMachineCacheKind::PackageJson, source_path, err);
            None
        }
    }
}

pub fn record_package_json_machine_cache_proof(event: &'static str, source_path: &[u8]) {
    let Some(path) = package_json_machine_cache_proof_log_path() else {
        return;
    };
    record_package_json_machine_cache_proof_slow(path, event, source_path);
}

#[inline]
fn package_json_machine_cache_proof_log_path() -> Option<&'static PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| std::env::var_os(PROOF_LOG_ENV).map(PathBuf::from))
        .as_ref()
}

#[cold]
fn record_package_json_machine_cache_proof_slow(
    path: &Path,
    event: &'static str,
    source_path: &[u8],
) {
    let source_path = std::str::from_utf8(source_path).unwrap_or("<non-utf8>");
    let mut escaped_source = String::with_capacity(source_path.len() + 8);
    push_json_string(&mut escaped_source, source_path);

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "{{\"event\":\"{}\",\"sourcePath\":{}}}",
            event, escaped_source
        );
    }
}

fn push_json_string(output: &mut String, value: &str) {
    output.push('"');
    for ch in value.chars() {
        match ch {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            ch if ch.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(output, "\\u{:04x}", ch as u32);
            }
            ch => output.push(ch),
        }
    }
    output.push('"');
}

#[cold]
fn warn_shadow_probe_error(kind: DxMachineCacheKind, source_path: &[u8], err: DxMachineCacheError) {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if WARNED.swap(true, Ordering::Relaxed) {
        return;
    }

    let source_path = std::str::from_utf8(source_path).unwrap_or("<non-utf8 path>");
    bun_core::Output::warn(format_args!(
        "[dx-machine-cache] shadow validation failed for {} {}: {}",
        kind.as_str(),
        source_path,
        err
    ));
}

#[cold]
fn warn_read_through_error(kind: DxMachineCacheKind, source_path: &[u8], err: DxMachineCacheError) {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if WARNED.swap(true, Ordering::Relaxed) {
        return;
    }

    let source_path = std::str::from_utf8(source_path).unwrap_or("<non-utf8 path>");
    bun_core::Output::warn(format_args!(
        "[dx-machine-cache] read-through failed for {} {}: {}",
        kind.as_str(),
        source_path,
        err
    ));
}

#[cold]
#[inline(never)]
fn shadow_probe_source_enabled(
    kind: DxMachineCacheKind,
    source_path: &[u8],
    source_bytes: &[u8],
) -> Result<Option<DxMachineShadowProbe>, DxMachineCacheError> {
    let Some(source_path) = path_from_utf8_bytes(source_path) else {
        return Ok(None);
    };
    let Some(root) = find_machine_cache_root(&source_path) else {
        return Ok(None);
    };
    let Some(source) = repo_relative_source(&root, &source_path) else {
        return Ok(None);
    };

    let catalog = cached_catalog_for_root(&root)?;
    let Some(entry) = catalog.find_entry(kind, &source) else {
        return Ok(None);
    };
    validate_current_source(&source_path, source_bytes, &entry)?;

    let shard = cached_shard_for_entry(&root, &catalog, &entry)?;

    let document = cached_document_for_entry(&root, &entry)?;

    match kind {
        DxMachineCacheKind::PackageJson => {
            let _ = document.package_json_summary();
        }
        DxMachineCacheKind::Tsconfig => {
            let _ = document.tsconfig_summary();
        }
        DxMachineCacheKind::Bunfig => {
            let _ = document.bunfig_summary();
        }
    }

    Ok(Some(DxMachineShadowProbe {
        kind,
        source: source.into_boxed_str(),
        machine: entry.machine.into(),
        mapped_bytes: document.mapped_bytes(),
        context_key_count: document.context_key_count(),
        shard_entry_count: shard.entry_count(),
    }))
}

#[cold]
#[inline(never)]
fn package_json_read_source_enabled(
    source_path: &[u8],
    source_bytes: &[u8],
) -> Result<Option<PackageJsonMachineRead>, DxMachineCacheError> {
    let Some(source_path) = path_from_utf8_bytes(source_path) else {
        return Ok(None);
    };
    let Some(root) = find_machine_cache_root(&source_path) else {
        return Ok(None);
    };
    let catalog = cached_catalog_for_root(&root)?;
    let Some(entry) = package_json_entry_for_path(&root, &source_path, &catalog) else {
        return Ok(None);
    };
    validate_current_source(&source_path, source_bytes, &entry)?;

    let shard = cached_shard_for_entry(&root, &catalog, &entry)?;

    if packed_package_json_read_enabled()
        && let Some(read) = shard.package_json_read_for_key(
            entry.key,
            entry.package_json_shard_index,
            Some(source_bytes),
        )
    {
        return Ok(Some(read));
    }

    let document = cached_document_for_entry(&root, &entry)?;

    Ok(document.package_json_read(shard.entry_count(), Some(source_bytes)))
}

fn package_json_read_path_enabled(
    source_path: &[u8],
) -> Result<Option<PackageJsonMachineRead>, DxMachineCacheError> {
    let Some(source_path) = path_from_utf8_bytes(source_path) else {
        return Ok(None);
    };
    if let Some(cache) = active_package_json_machine_cache(source_path) {
        return package_json_read_path_active_enabled(cache, source_path);
    }

    let Some(root) = find_machine_cache_root(&source_path) else {
        return Ok(None);
    };
    let catalog = cached_catalog_for_root(&root)?;
    let Some(entry) = package_json_entry_for_path(&root, &source_path, &catalog) else {
        return Ok(None);
    };
    let trusted_package_json_snapshot = trusted_package_json_snapshot_for_root(&root);
    let trust_source_metadata = trust_source_metadata_enabled();
    let source_bytes = if trusted_package_json_snapshot {
        None
    } else if trust_source_metadata {
        if !trust_package_json_snapshot_enabled() {
            validate_current_source_metadata(&source_path, &entry)?;
        }
        None
    } else {
        record_package_json_machine_cache_proof(
            "source_validation_read",
            source_path.as_os_str().as_encoded_bytes(),
        );
        let source_bytes = read_current_source_validated(&source_path, &entry)?;
        Some(source_bytes)
    };

    let use_packed_document = packed_document_read_enabled();
    let trust_package_json_read = trust_package_json_read_enabled();
    let use_packed_package_json = packed_package_json_read_enabled()
        && (source_bytes.is_some() || trusted_package_json_snapshot || trust_package_json_read);
    let shard = if trust_source_metadata && !use_packed_document && !use_packed_package_json {
        None
    } else {
        Some(cached_shard_for_entry(&root, &catalog, &entry)?)
    };
    let shard_entry_count = shard.as_ref().map(|shard| shard.entry_count()).unwrap_or(0);

    if use_packed_package_json
        && let Some(shard) = shard.as_ref()
        && let Some(read) = shard.package_json_read_for_key(
            entry.key,
            entry.package_json_shard_index,
            source_bytes.as_deref(),
        )
    {
        return Ok(Some(read));
    }

    let document = if use_packed_document {
        if let Some(shard) = shard.as_ref() {
            cached_document_for_packed_shard_entry(&root, &entry, shard)?
        } else {
            cached_document_for_entry(&root, &entry)?
        }
    } else {
        cached_document_for_entry(&root, &entry)?
    };

    Ok(document.package_json_read(shard_entry_count, source_bytes.as_deref()))
}

fn package_json_read_path_ref_enabled<T>(
    source_path: &[u8],
    convert: impl FnOnce(PackageJsonMachineReadRef<'_>) -> Option<T>,
) -> Result<Option<T>, DxMachineCacheError> {
    let Some(source_path) = path_from_utf8_bytes(source_path) else {
        return Ok(None);
    };
    if let Some(cache) = active_package_json_machine_cache(source_path) {
        return package_json_read_path_ref_active_enabled(cache, source_path, convert);
    }

    let Some(root) = find_machine_cache_root(&source_path) else {
        return Ok(None);
    };
    let catalog = cached_catalog_for_root(&root)?;
    let Some(entry) = package_json_entry_for_path(&root, &source_path, &catalog) else {
        return Ok(None);
    };
    let trusted_package_json_snapshot = trusted_package_json_snapshot_for_root(&root);
    let trust_source_metadata = trust_source_metadata_enabled();
    let source_bytes = if trusted_package_json_snapshot {
        None
    } else if trust_source_metadata {
        if !trust_package_json_snapshot_enabled() {
            validate_current_source_metadata(&source_path, &entry)?;
        }
        None
    } else {
        record_package_json_machine_cache_proof(
            "source_validation_read",
            source_path.as_os_str().as_encoded_bytes(),
        );
        let source_bytes = read_current_source_validated(&source_path, &entry)?;
        Some(source_bytes)
    };

    let shard = cached_shard_for_entry(&root, &catalog, &entry)?;
    Ok(shard
        .package_json_read_ref_for_key(
            entry.key,
            entry.package_json_shard_index,
            source_bytes.as_deref(),
        )
        .and_then(convert))
}

fn package_json_read_path_active_enabled(
    cache: &ActivePackageJsonMachineCache,
    source_path: &Path,
) -> Result<Option<PackageJsonMachineRead>, DxMachineCacheError> {
    let Some(entry) = package_json_entry_for_path(&cache.root, source_path, &cache.catalog) else {
        return Ok(None);
    };
    let trusted_package_json_snapshot = cache.trusted_package_json_snapshot;
    let trust_source_metadata = trust_source_metadata_enabled();
    let source_bytes = if trusted_package_json_snapshot {
        None
    } else if trust_source_metadata {
        if !trust_package_json_snapshot_enabled() {
            validate_current_source_metadata(source_path, &entry)?;
        }
        None
    } else {
        record_package_json_machine_cache_proof(
            "source_validation_read",
            source_path.as_os_str().as_encoded_bytes(),
        );
        let source_bytes = read_current_source_validated(source_path, &entry)?;
        Some(source_bytes)
    };

    let use_packed_document = packed_document_read_enabled();
    let trust_package_json_read = trust_package_json_read_enabled();
    let use_packed_package_json = packed_package_json_read_enabled()
        && (source_bytes.is_some() || trusted_package_json_snapshot || trust_package_json_read);
    let shard = if trust_source_metadata && !use_packed_document && !use_packed_package_json {
        None
    } else {
        Some(active_package_json_shard_for_entry(cache, &entry)?)
    };
    let shard_entry_count = shard.as_ref().map(|shard| shard.entry_count()).unwrap_or(0);

    if use_packed_package_json
        && let Some(shard) = shard.as_ref()
        && let Some(read) = shard.package_json_read_for_key(
            entry.key,
            entry.package_json_shard_index,
            source_bytes.as_deref(),
        )
    {
        return Ok(Some(read));
    }

    let document = if use_packed_document {
        if let Some(shard) = shard.as_ref() {
            cached_document_for_packed_shard_entry(&cache.root, &entry, shard)?
        } else {
            cached_document_for_entry(&cache.root, &entry)?
        }
    } else {
        cached_document_for_entry(&cache.root, &entry)?
    };

    Ok(document.package_json_read(shard_entry_count, source_bytes.as_deref()))
}

fn package_json_read_path_ref_active_enabled<T>(
    cache: &ActivePackageJsonMachineCache,
    source_path: &Path,
    convert: impl FnOnce(PackageJsonMachineReadRef<'_>) -> Option<T>,
) -> Result<Option<T>, DxMachineCacheError> {
    let Some(entry) = package_json_entry_for_path(&cache.root, source_path, &cache.catalog) else {
        return Ok(None);
    };
    let trusted_package_json_snapshot = cache.trusted_package_json_snapshot;
    let trust_source_metadata = trust_source_metadata_enabled();
    let source_bytes = if trusted_package_json_snapshot {
        None
    } else if trust_source_metadata {
        if !trust_package_json_snapshot_enabled() {
            validate_current_source_metadata(source_path, &entry)?;
        }
        None
    } else {
        record_package_json_machine_cache_proof(
            "source_validation_read",
            source_path.as_os_str().as_encoded_bytes(),
        );
        let source_bytes = read_current_source_validated(source_path, &entry)?;
        Some(source_bytes)
    };

    let shard = active_package_json_shard_for_entry(cache, &entry)?;
    Ok(shard
        .package_json_read_ref_for_key(
            entry.key,
            entry.package_json_shard_index,
            source_bytes.as_deref(),
        )
        .and_then(convert))
}

fn active_package_json_shard_for_entry(
    cache: &ActivePackageJsonMachineCache,
    entry: &TrustedCatalogEntry<'_>,
) -> Result<Arc<TrustedPackedShardMachine>, DxMachineCacheError> {
    if let Some(active_shard) = cache.package_json_shard.get()
        && active_shard.name.as_ref() == entry.shard
    {
        return Ok(Arc::clone(&active_shard.shard));
    }

    let shard = cached_shard_for_entry_with_trust(
        &cache.root,
        &cache.catalog,
        entry,
        cache.trusted_package_json_snapshot,
    )?;
    let _ = cache.package_json_shard.set(ActivePackageJsonShard {
        name: Box::from(entry.shard),
        shard: Arc::clone(&shard),
    });

    Ok(shard)
}

fn cached_catalog_for_root(root: &Path) -> Result<Arc<TrustedCatalogMachine>, DxMachineCacheError> {
    let path = root.join(".dx").join("js").join("catalog.machine");
    let trusted_package_json_snapshot = trusted_package_json_snapshot_for_root(root);
    let mut store = process_cache()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    if let Some(catalog) = store.catalogs.get(&path) {
        return Ok(Arc::clone(catalog));
    }

    let catalog = Arc::new(TrustedCatalogMachine::open_with_trust(
        &path,
        trusted_package_json_snapshot,
    )?);
    store.catalogs.insert(path, Arc::clone(&catalog));
    Ok(catalog)
}

fn package_json_entry_for_path<'a>(
    root: &Path,
    source_path: &Path,
    catalog: &'a TrustedCatalogMachine,
) -> Option<TrustedCatalogEntry<'a>> {
    if let Some(package_name) = node_modules_package_json_name(root, source_path)
        && let Some(indexed) = catalog.package_json_node_modules_index().get(package_name)
    {
        return catalog.entry_for_package_json_indexed(*indexed);
    }

    let indexed = catalog.package_json_path_index(root).get(source_path)?;
    catalog.entry_for_package_json_indexed(*indexed)
}

fn catalog_source_path(root: &Path, source: &str) -> Option<PathBuf> {
    if source.is_empty() || source.contains('\0') {
        return None;
    }

    let mut path = root.to_path_buf();
    for component in source.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.contains('\\')
            || component.contains(':')
        {
            return None;
        }
        path.push(component);
    }

    Some(path)
}

fn node_modules_package_json_name<'a>(root: &Path, source_path: &'a Path) -> Option<&'a str> {
    let relative = source_path.strip_prefix(root).ok()?;
    let mut components = relative.components();
    let Component::Normal(node_modules) = components.next()? else {
        return None;
    };
    if !node_modules.eq_ignore_ascii_case("node_modules") {
        return None;
    }
    let Component::Normal(package_name) = components.next()? else {
        return None;
    };
    let package_name = package_name.to_str()?;
    if package_name.is_empty() || package_name.starts_with('@') {
        return None;
    }
    let Component::Normal(package_json) = components.next()? else {
        return None;
    };
    if package_json.to_str()? != "package.json" || components.next().is_some() {
        return None;
    }

    Some(package_name)
}

fn node_modules_package_json_source_name(source: &str) -> Option<&str> {
    let rest = source.strip_prefix("node_modules/")?;
    let (package_name, leaf) = rest.split_once('/')?;
    if package_name.is_empty() || package_name.starts_with('@') || leaf != "package.json" {
        return None;
    }

    Some(package_name)
}

fn cached_shard_for_entry(
    root: &Path,
    catalog: &TrustedCatalogMachine,
    entry: &TrustedCatalogEntry<'_>,
) -> Result<Arc<TrustedPackedShardMachine>, DxMachineCacheError> {
    let trusted_package_json_snapshot = trusted_package_json_snapshot_for_root(root);
    cached_shard_for_entry_with_trust(root, catalog, entry, trusted_package_json_snapshot)
}

fn cached_shard_for_entry_with_trust(
    root: &Path,
    catalog: &TrustedCatalogMachine,
    entry: &TrustedCatalogEntry<'_>,
    trusted_package_json_snapshot: bool,
) -> Result<Arc<TrustedPackedShardMachine>, DxMachineCacheError> {
    let path = root
        .join(".dx")
        .join("js")
        .join("shards")
        .join(entry.shard)
        .with_extension("dxjs");
    let mut store = process_cache()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    if let Some(shard) = store.shards.get(&path) {
        return Ok(Arc::clone(shard));
    }

    let shard = Arc::new(TrustedPackedShardMachine::open_with_trust(
        &path,
        trusted_package_json_snapshot,
    )?);
    if !trusted_package_json_snapshot {
        catalog.validate_shard(&path, &shard, entry.shard, entry.key)?;
    }
    store.shards.insert(path.clone(), Arc::clone(&shard));
    Ok(shard)
}

fn active_package_json_machine_cache(
    source_path: &Path,
) -> Option<&'static ActivePackageJsonMachineCache> {
    ACTIVE_PACKAGE_JSON_CACHE
        .get_or_init(build_active_package_json_machine_cache)
        .as_ref()
        .filter(|cache| source_path.starts_with(&cache.root))
}

fn build_active_package_json_machine_cache() -> Option<ActivePackageJsonMachineCache> {
    let root = configured_machine_cache_root()
        .cloned()
        .or_else(current_dir_machine_cache_root)?;
    let trusted_package_json_snapshot = trust_package_json_snapshot_enabled()
        || root_has_trusted_package_json_snapshot_uncached(&root);
    let path = root.join(".dx").join("js").join("catalog.machine");
    let catalog = Arc::new(
        TrustedCatalogMachine::open_with_trust(&path, trusted_package_json_snapshot).ok()?,
    );

    Some(ActivePackageJsonMachineCache {
        root,
        catalog,
        trusted_package_json_snapshot,
        package_json_shard: OnceLock::new(),
    })
}

fn current_dir_machine_cache_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    if cwd.as_os_str().is_empty() || path_contains_node_modules_component(&cwd) {
        return None;
    }

    find_machine_cache_root_uncached(&cwd)
}

fn cached_document_for_entry(
    root: &Path,
    entry: &TrustedCatalogEntry<'_>,
) -> Result<Arc<TrustedMachineDocument>, DxMachineCacheError> {
    let path = root.join(entry.machine);
    let key = MachineDocumentCacheKey {
        path: path.clone(),
        expected_bytes: entry.machine_bytes,
        expected_blake3: Box::from(entry.machine_blake3),
    };
    let mut store = process_cache()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    if let Some(document) = store.documents.get(&key) {
        return Ok(Arc::clone(document));
    }

    let document = Arc::new(TrustedMachineDocument::open(
        &path,
        entry.machine_bytes,
        entry.machine_blake3,
    )?);
    store.documents.insert(key, Arc::clone(&document));
    Ok(document)
}

fn cached_document_for_packed_shard_entry(
    root: &Path,
    entry: &TrustedCatalogEntry<'_>,
    shard: &TrustedPackedShardMachine,
) -> Result<Arc<TrustedMachineDocument>, DxMachineCacheError> {
    let Some(machine_document) = shard.machine_document_for_key(entry.key) else {
        return cached_document_for_entry(root, entry);
    };

    let path = root.join(entry.machine);
    let key = MachineDocumentCacheKey {
        path: path.clone(),
        expected_bytes: entry.machine_bytes,
        expected_blake3: Box::from(entry.machine_blake3),
    };
    let mut store = process_cache()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    if let Some(document) = store.documents.get(&key) {
        return Ok(Arc::clone(document));
    }

    let document = Arc::new(TrustedMachineDocument::from_bytes(
        &path,
        Box::<[u8]>::from(machine_document),
        entry.machine_bytes,
        entry.machine_blake3,
    )?);
    store.documents.insert(key, Arc::clone(&document));
    Ok(document)
}

fn process_cache() -> &'static Mutex<DxMachineCacheStore> {
    PROCESS_CACHE.get_or_init(|| Mutex::new(DxMachineCacheStore::new()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackageJsonMachineSummary<'a> {
    pub name: Option<&'a str>,
    pub version: Option<&'a str>,
    pub module_type: Option<&'a str>,
    pub has_exports: bool,
    pub has_imports: bool,
    pub has_scripts: bool,
    pub dependency_count: usize,
    pub dev_dependency_count: usize,
    pub optional_dependency_count: usize,
    pub peer_dependency_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TsconfigMachineSummary<'a> {
    pub extends: Option<&'a str>,
    pub has_compiler_options: bool,
    pub base_url: Option<&'a str>,
    pub jsx: Option<&'a str>,
    pub jsx_factory: Option<&'a str>,
    pub jsx_fragment_factory: Option<&'a str>,
    pub jsx_import_source: Option<&'a str>,
    pub use_define_for_class_fields: Option<bool>,
    pub has_paths: bool,
    pub paths_pattern_count: usize,
    pub include_count: usize,
    pub exclude_count: usize,
    pub references_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BunfigMachineSummary<'a> {
    pub jsx: Option<&'a str>,
    pub jsx_factory: Option<&'a str>,
    pub jsx_fragment: Option<&'a str>,
    pub jsx_import_source: Option<&'a str>,
    pub telemetry: Option<bool>,
    pub has_define: bool,
    pub define_count: usize,
    pub has_test: bool,
    pub test_key_count: usize,
    pub has_install: bool,
    pub install_key_count: usize,
    pub install_scopes_count: usize,
    pub has_serve: bool,
    pub serve_key_count: usize,
}

pub struct TrustedCatalogMachine {
    mmap: Mmap,
    package_json_source_index: OnceLock<FastHashMap<Box<str>, PackageJsonSourceIndexEntry>>,
    package_json_node_modules_index: OnceLock<FastHashMap<Box<str>, PackageJsonSourceIndexEntry>>,
    package_json_path_index: OnceLock<FastHashMap<PathBuf, PackageJsonSourceIndexEntry>>,
}

pub struct TrustedCatalogEntry<'a> {
    pub key: &'a str,
    pub source: &'a str,
    pub shard: &'a str,
    pub machine: &'a str,
    pub source_blake3: &'a str,
    pub source_bytes: u64,
    pub source_modified_unix_ms: Option<u64>,
    pub machine_blake3: &'a str,
    pub machine_bytes: u64,
    package_json_shard_index: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PackageJsonSourceIndexEntry {
    catalog_index: u32,
    shard_index: u32,
}

impl TrustedCatalogMachine {
    pub fn open(path: &Path) -> Result<Self, DxMachineCacheError> {
        Self::open_with_trust(path, trust_package_json_snapshot_enabled())
    }

    fn open_with_trust(
        path: &Path,
        trust_package_json_snapshot: bool,
    ) -> Result<Self, DxMachineCacheError> {
        let mmap = mmap_file(path)?;
        if !trust_package_json_snapshot {
            bytecheck_catalog(path, &mmap)?;
        }
        let catalog = unsafe { rkyv::access_unchecked::<ArchivedJsCacheCatalogMachine>(&mmap) };
        if catalog.schema.as_str() != CATALOG_MACHINE_SCHEMA {
            return Err(invalid(path, "catalog schema mismatch"));
        }
        if !trust_package_json_snapshot {
            validate_catalog(path, catalog)?;
        }
        Ok(Self {
            mmap,
            package_json_source_index: OnceLock::new(),
            package_json_node_modules_index: OnceLock::new(),
            package_json_path_index: OnceLock::new(),
        })
    }

    #[inline]
    fn archived(&self) -> &ArchivedJsCacheCatalogMachine {
        unsafe { rkyv::access_unchecked::<ArchivedJsCacheCatalogMachine>(&self.mmap) }
    }

    #[inline]
    pub fn entry_count(&self) -> usize {
        self.archived().entries.len()
    }

    pub fn find_entry(
        &self,
        kind: DxMachineCacheKind,
        source: &str,
    ) -> Option<TrustedCatalogEntry<'_>> {
        let catalog = self.archived();
        let lookup = catalog
            .lookup
            .binary_search_by(|lookup| {
                compare_lookup_key(lookup.key.as_str(), kind.as_str(), source)
            })
            .ok()
            .and_then(|index| catalog.lookup.get(index))?;
        let index = usize::try_from(lookup.index.to_native()).ok()?;
        self.entry_at_index(index)
    }

    pub fn find_package_json_entry(&self, source: &str) -> Option<TrustedCatalogEntry<'_>> {
        let indexed = self.package_json_source_index().get(source)?;
        self.entry_for_package_json_indexed(*indexed)
    }

    fn entry_for_package_json_indexed(
        &self,
        indexed: PackageJsonSourceIndexEntry,
    ) -> Option<TrustedCatalogEntry<'_>> {
        let index = usize::try_from(indexed.catalog_index).ok()?;
        let mut entry = self.entry_at_index(index)?;
        entry.package_json_shard_index = Some(indexed.shard_index);
        Some(entry)
    }

    fn package_json_source_index(&self) -> &FastHashMap<Box<str>, PackageJsonSourceIndexEntry> {
        self.package_json_source_index.get_or_init(|| {
            let catalog = self.archived();
            let mut index =
                HashMap::with_capacity_and_hasher(catalog.entries.len(), Default::default());
            let mut shard_offsets: FastHashMap<Box<str>, u32> = HashMap::default();
            for (entry_index, entry) in catalog.entries.iter().enumerate() {
                if entry.kind.as_str() != DxMachineCacheKind::PackageJson.as_str() {
                    continue;
                }
                let Ok(catalog_index) = u32::try_from(entry_index) else {
                    continue;
                };
                let shard_offset = shard_offsets
                    .entry(Box::<str>::from(entry.shard.as_str()))
                    .or_default();
                let shard_index = *shard_offset;
                *shard_offset = shard_offset.saturating_add(1);
                index.insert(
                    Box::<str>::from(entry.source.as_str()),
                    PackageJsonSourceIndexEntry {
                        catalog_index,
                        shard_index,
                    },
                );
            }
            index
        })
    }

    fn package_json_node_modules_index(
        &self,
    ) -> &FastHashMap<Box<str>, PackageJsonSourceIndexEntry> {
        self.package_json_node_modules_index.get_or_init(|| {
            let catalog = self.archived();
            let mut index = HashMap::default();
            let mut shard_offsets: FastHashMap<Box<str>, u32> = HashMap::default();
            for (entry_index, entry) in catalog.entries.iter().enumerate() {
                if entry.kind.as_str() != DxMachineCacheKind::PackageJson.as_str() {
                    continue;
                }
                let Ok(catalog_index) = u32::try_from(entry_index) else {
                    continue;
                };
                let shard_offset = shard_offsets
                    .entry(Box::<str>::from(entry.shard.as_str()))
                    .or_default();
                let shard_index = *shard_offset;
                *shard_offset = shard_offset.saturating_add(1);
                let Some(package_name) =
                    node_modules_package_json_source_name(entry.source.as_str())
                else {
                    continue;
                };
                index.insert(
                    Box::<str>::from(package_name),
                    PackageJsonSourceIndexEntry {
                        catalog_index,
                        shard_index,
                    },
                );
            }
            index
        })
    }

    fn package_json_path_index(
        &self,
        root: &Path,
    ) -> &FastHashMap<PathBuf, PackageJsonSourceIndexEntry> {
        self.package_json_path_index.get_or_init(|| {
            let catalog = self.archived();
            let mut index =
                HashMap::with_capacity_and_hasher(catalog.entries.len(), Default::default());
            let mut shard_offsets: FastHashMap<Box<str>, u32> = HashMap::default();
            for (entry_index, entry) in catalog.entries.iter().enumerate() {
                if entry.kind.as_str() != DxMachineCacheKind::PackageJson.as_str() {
                    continue;
                }
                let Ok(catalog_index) = u32::try_from(entry_index) else {
                    continue;
                };
                let shard_offset = shard_offsets
                    .entry(Box::<str>::from(entry.shard.as_str()))
                    .or_default();
                let shard_index = *shard_offset;
                *shard_offset = shard_offset.saturating_add(1);
                let Some(source_path) = catalog_source_path(root, entry.source.as_str()) else {
                    continue;
                };
                index.insert(
                    source_path,
                    PackageJsonSourceIndexEntry {
                        catalog_index,
                        shard_index,
                    },
                );
            }
            index
        })
    }

    fn entry_at_index(&self, index: usize) -> Option<TrustedCatalogEntry<'_>> {
        let entry = self.archived().entries.get(index)?;
        Some(TrustedCatalogEntry {
            key: entry.key.as_str(),
            source: entry.source.as_str(),
            shard: entry.shard.as_str(),
            machine: entry.machine.as_str(),
            source_blake3: entry.source_blake3.as_str(),
            source_bytes: entry.source_bytes.to_native(),
            source_modified_unix_ms: entry
                .source_modified_unix_ms
                .as_ref()
                .map(|value| value.to_native()),
            machine_blake3: entry.machine_blake3.as_str(),
            machine_bytes: entry.machine_bytes.to_native(),
            package_json_shard_index: None,
        })
    }

    fn validate_shard(
        &self,
        path: &Path,
        shard: &TrustedPackedShardMachine,
        shard_name: &str,
        selected_key: &str,
    ) -> Result<(), DxMachineCacheError> {
        match shard.header().version {
            1 => self.validate_shard_v1(path, shard, shard_name, selected_key),
            2 => self.validate_shard_v2(path, shard, shard_name, selected_key),
            3 | 4 => self.validate_shard_v3(path, shard, shard_name, selected_key),
            5 => self.validate_shard_v5(path, shard, shard_name, selected_key),
            _ => Err(invalid(path, "packed shard version mismatch")),
        }
    }

    fn validate_shard_v1(
        &self,
        path: &Path,
        shard: &TrustedPackedShardMachine,
        shard_name: &str,
        selected_key: &str,
    ) -> Result<(), DxMachineCacheError> {
        let catalog = self.archived();
        let shard_machine = shard.archived();
        if shard_machine.shard.as_str() != shard_name {
            return Err(invalid(path, "catalog shard path mismatch"));
        }

        let mut shard_entries = shard_machine.entries.iter();
        let mut source_bytes = 0u64;
        let mut machine_bytes = 0u64;
        let mut metadata_bytes = 0u64;
        let mut matched_count = 0usize;
        let mut found_selected = false;

        for catalog_entry in catalog
            .entries
            .iter()
            .filter(|entry| entry.shard.as_str() == shard_name)
        {
            let Some(shard_entry) = shard_entries.next() else {
                return Err(invalid(path, "catalog shard entry count mismatch"));
            };

            validate_catalog_shard_entry(path, catalog_entry, shard_entry)?;
            source_bytes = checked_add_u64(
                source_bytes,
                catalog_entry.source_bytes.to_native(),
                path,
                "packed shard source byte total overflow",
            )?;
            machine_bytes = checked_add_u64(
                machine_bytes,
                catalog_entry.machine_bytes.to_native(),
                path,
                "packed shard machine byte total overflow",
            )?;
            metadata_bytes = checked_add_u64(
                metadata_bytes,
                catalog_entry.metadata_bytes.to_native(),
                path,
                "packed shard metadata byte total overflow",
            )?;
            matched_count += 1;
            found_selected |= catalog_entry.key.as_str() == selected_key;
        }

        if shard_entries.next().is_some() {
            return Err(invalid(path, "catalog shard entry count mismatch"));
        }
        if matched_count == 0 {
            return Err(invalid(path, "catalog shard has no matching entries"));
        }
        if !found_selected {
            return Err(invalid(path, "selected catalog entry missing from shard"));
        }

        let header = shard.header();
        if header.source_bytes != source_bytes {
            return Err(invalid(path, "packed shard source byte total mismatch"));
        }
        if header.machine_bytes != machine_bytes {
            return Err(invalid(path, "packed shard machine byte total mismatch"));
        }
        if header.metadata_bytes != metadata_bytes {
            return Err(invalid(path, "packed shard metadata byte total mismatch"));
        }

        Ok(())
    }

    fn validate_shard_v2(
        &self,
        path: &Path,
        shard: &TrustedPackedShardMachine,
        shard_name: &str,
        selected_key: &str,
    ) -> Result<(), DxMachineCacheError> {
        let catalog = self.archived();
        let shard_machine = shard.archived_v2();
        if shard_machine.shard.as_str() != shard_name {
            return Err(invalid(path, "catalog shard path mismatch"));
        }

        let mut shard_entries = shard_machine.entries.iter();
        let mut source_bytes = 0u64;
        let mut machine_bytes = 0u64;
        let mut metadata_bytes = 0u64;
        let mut matched_count = 0usize;
        let mut found_selected = false;

        for catalog_entry in catalog
            .entries
            .iter()
            .filter(|entry| entry.shard.as_str() == shard_name)
        {
            let Some(shard_entry) = shard_entries.next() else {
                return Err(invalid(path, "catalog shard entry count mismatch"));
            };

            validate_catalog_shard_entry_v2(path, catalog_entry, shard_entry)?;
            source_bytes = checked_add_u64(
                source_bytes,
                catalog_entry.source_bytes.to_native(),
                path,
                "packed shard source byte total overflow",
            )?;
            machine_bytes = checked_add_u64(
                machine_bytes,
                catalog_entry.machine_bytes.to_native(),
                path,
                "packed shard machine byte total overflow",
            )?;
            metadata_bytes = checked_add_u64(
                metadata_bytes,
                catalog_entry.metadata_bytes.to_native(),
                path,
                "packed shard metadata byte total overflow",
            )?;
            matched_count += 1;
            found_selected |= catalog_entry.key.as_str() == selected_key;
        }

        if shard_entries.next().is_some() {
            return Err(invalid(path, "catalog shard entry count mismatch"));
        }
        if matched_count == 0 {
            return Err(invalid(path, "catalog shard has no matching entries"));
        }
        if !found_selected {
            return Err(invalid(path, "selected catalog entry missing from shard"));
        }

        let header = shard.header();
        if header.source_bytes != source_bytes {
            return Err(invalid(path, "packed shard source byte total mismatch"));
        }
        if header.machine_bytes != machine_bytes {
            return Err(invalid(path, "packed shard machine byte total mismatch"));
        }
        if header.metadata_bytes != metadata_bytes {
            return Err(invalid(path, "packed shard metadata byte total mismatch"));
        }

        Ok(())
    }

    fn validate_shard_v3(
        &self,
        path: &Path,
        shard: &TrustedPackedShardMachine,
        shard_name: &str,
        selected_key: &str,
    ) -> Result<(), DxMachineCacheError> {
        let catalog = self.archived();
        let shard_machine = shard.archived_v3();
        if shard_machine.shard.as_str() != shard_name {
            return Err(invalid(path, "catalog shard path mismatch"));
        }

        let mut shard_entries = shard_machine.entries.iter();
        let mut source_bytes = 0u64;
        let mut machine_bytes = 0u64;
        let mut metadata_bytes = 0u64;
        let mut matched_count = 0usize;
        let mut found_selected = false;

        for catalog_entry in catalog
            .entries
            .iter()
            .filter(|entry| entry.shard.as_str() == shard_name)
        {
            let Some(shard_entry) = shard_entries.next() else {
                return Err(invalid(path, "catalog shard entry count mismatch"));
            };

            validate_catalog_shard_entry_v3(path, catalog_entry, shard_entry)?;
            source_bytes = checked_add_u64(
                source_bytes,
                catalog_entry.source_bytes.to_native(),
                path,
                "packed shard source byte total overflow",
            )?;
            machine_bytes = checked_add_u64(
                machine_bytes,
                catalog_entry.machine_bytes.to_native(),
                path,
                "packed shard machine byte total overflow",
            )?;
            metadata_bytes = checked_add_u64(
                metadata_bytes,
                catalog_entry.metadata_bytes.to_native(),
                path,
                "packed shard metadata byte total overflow",
            )?;
            matched_count += 1;
            found_selected |= catalog_entry.key.as_str() == selected_key;
        }

        if shard_entries.next().is_some() {
            return Err(invalid(path, "catalog shard entry count mismatch"));
        }
        if matched_count == 0 {
            return Err(invalid(path, "catalog shard has no matching entries"));
        }
        if !found_selected {
            return Err(invalid(path, "selected catalog entry missing from shard"));
        }

        let header = shard.header();
        if header.source_bytes != source_bytes {
            return Err(invalid(path, "packed shard source byte total mismatch"));
        }
        if header.machine_bytes != machine_bytes {
            return Err(invalid(path, "packed shard machine byte total mismatch"));
        }
        if header.metadata_bytes != metadata_bytes {
            return Err(invalid(path, "packed shard metadata byte total mismatch"));
        }

        Ok(())
    }

    fn validate_shard_v5(
        &self,
        path: &Path,
        shard: &TrustedPackedShardMachine,
        shard_name: &str,
        selected_key: &str,
    ) -> Result<(), DxMachineCacheError> {
        let catalog = self.archived();
        let shard_machine = shard.archived_v5();
        if shard_machine.shard.as_str() != shard_name {
            return Err(invalid(path, "catalog shard path mismatch"));
        }

        let mut shard_entries = shard_machine.entries.iter();
        let mut source_bytes = 0u64;
        let mut machine_bytes = 0u64;
        let mut metadata_bytes = 0u64;
        let mut matched_count = 0usize;
        let mut found_selected = false;

        for catalog_entry in catalog
            .entries
            .iter()
            .filter(|entry| entry.shard.as_str() == shard_name)
        {
            let Some(shard_entry) = shard_entries.next() else {
                return Err(invalid(path, "catalog shard entry count mismatch"));
            };

            validate_catalog_shard_entry_v5(path, catalog_entry, shard_entry)?;
            source_bytes = checked_add_u64(
                source_bytes,
                catalog_entry.source_bytes.to_native(),
                path,
                "packed shard source byte total overflow",
            )?;
            machine_bytes = checked_add_u64(
                machine_bytes,
                catalog_entry.machine_bytes.to_native(),
                path,
                "packed shard machine byte total overflow",
            )?;
            metadata_bytes = checked_add_u64(
                metadata_bytes,
                catalog_entry.metadata_bytes.to_native(),
                path,
                "packed shard metadata byte total overflow",
            )?;
            matched_count += 1;
            found_selected |= catalog_entry.key.as_str() == selected_key;
        }

        if shard_entries.next().is_some() {
            return Err(invalid(path, "catalog shard entry count mismatch"));
        }
        if matched_count == 0 {
            return Err(invalid(path, "catalog shard has no matching entries"));
        }
        if !found_selected {
            return Err(invalid(path, "selected catalog entry missing from shard"));
        }

        let header = shard.header();
        if header.source_bytes != source_bytes {
            return Err(invalid(path, "packed shard source byte total mismatch"));
        }
        if header.machine_bytes != machine_bytes {
            return Err(invalid(path, "packed shard machine byte total mismatch"));
        }
        if header.metadata_bytes != metadata_bytes {
            return Err(invalid(path, "packed shard metadata byte total mismatch"));
        }

        Ok(())
    }
}

pub struct TrustedPackedShardMachine {
    mmap: Mmap,
}

impl TrustedPackedShardMachine {
    pub fn open(path: &Path) -> Result<Self, DxMachineCacheError> {
        Self::open_with_trust(path, trust_package_json_snapshot_enabled())
    }

    fn open_with_trust(
        path: &Path,
        trust_package_json_snapshot: bool,
    ) -> Result<Self, DxMachineCacheError> {
        let mmap = mmap_file(path)?;
        if mmap.len() < SHARD_HEADER_BYTES {
            return Err(invalid(path, "packed shard is smaller than header"));
        }

        let header = packed_shard_header(&mmap[..SHARD_HEADER_BYTES])?;
        if header.magic != SHARD_MAGIC {
            return Err(invalid(path, "packed shard magic mismatch"));
        }
        if header.header_bytes as usize != SHARD_HEADER_BYTES {
            return Err(invalid(path, "packed shard header length mismatch"));
        }

        let body = &mmap[SHARD_HEADER_BYTES..];
        match header.version {
            1 => {
                if !trust_package_json_snapshot {
                    bytecheck_shard(path, body)?;
                }
                let shard = unsafe { rkyv::access_unchecked::<ArchivedJsCacheShardMachine>(body) };
                if shard.schema.as_str() != SHARD_MACHINE_SCHEMA {
                    return Err(invalid(path, "packed shard schema mismatch"));
                }
                if !trust_package_json_snapshot {
                    validate_packed_shard(path, header, shard)?;
                }
            }
            2 => {
                if !trust_package_json_snapshot {
                    bytecheck_shard_v2(path, body)?;
                }
                let shard =
                    unsafe { rkyv::access_unchecked::<ArchivedJsCacheShardMachineV2>(body) };
                if shard.schema.as_str() != SHARD_MACHINE_SCHEMA_V2 {
                    return Err(invalid(path, "packed shard schema mismatch"));
                }
                if !trust_package_json_snapshot {
                    validate_packed_shard_v2(path, header, shard)?;
                }
            }
            3 => {
                if !trust_package_json_snapshot {
                    bytecheck_shard_v3(path, body)?;
                }
                let shard =
                    unsafe { rkyv::access_unchecked::<ArchivedJsCacheShardMachineV3>(body) };
                if shard.schema.as_str() != SHARD_MACHINE_SCHEMA_V3 {
                    return Err(invalid(path, "packed shard schema mismatch"));
                }
                if !trust_package_json_snapshot {
                    validate_packed_shard_v3(path, header, shard)?;
                }
            }
            4 => {
                if !trust_package_json_snapshot {
                    bytecheck_shard_v3(path, body)?;
                }
                let shard =
                    unsafe { rkyv::access_unchecked::<ArchivedJsCacheShardMachineV3>(body) };
                if shard.schema.as_str() != SHARD_MACHINE_SCHEMA_V4 {
                    return Err(invalid(path, "packed shard schema mismatch"));
                }
                if !trust_package_json_snapshot {
                    validate_packed_shard_v4(path, header, shard)?;
                }
            }
            5 => {
                if !trust_package_json_snapshot {
                    bytecheck_shard_v5(path, body)?;
                }
                let shard =
                    unsafe { rkyv::access_unchecked::<ArchivedJsCacheShardMachineV5>(body) };
                if shard.schema.as_str() != SHARD_MACHINE_SCHEMA_V5 {
                    return Err(invalid(path, "packed shard schema mismatch"));
                }
                if !trust_package_json_snapshot {
                    validate_packed_shard_v5(path, header, shard)?;
                }
            }
            _ => return Err(invalid(path, "packed shard version mismatch")),
        }

        Ok(Self { mmap })
    }

    #[inline]
    pub fn header(&self) -> &DxJsMachineCachePackedShardHeader {
        bytemuck::from_bytes(&self.mmap[..SHARD_HEADER_BYTES])
    }

    #[inline]
    fn archived(&self) -> &ArchivedJsCacheShardMachine {
        unsafe {
            rkyv::access_unchecked::<ArchivedJsCacheShardMachine>(&self.mmap[SHARD_HEADER_BYTES..])
        }
    }

    #[inline]
    fn archived_v2(&self) -> &ArchivedJsCacheShardMachineV2 {
        unsafe {
            rkyv::access_unchecked::<ArchivedJsCacheShardMachineV2>(
                &self.mmap[SHARD_HEADER_BYTES..],
            )
        }
    }

    #[inline]
    fn archived_v3(&self) -> &ArchivedJsCacheShardMachineV3 {
        unsafe {
            rkyv::access_unchecked::<ArchivedJsCacheShardMachineV3>(
                &self.mmap[SHARD_HEADER_BYTES..],
            )
        }
    }

    #[inline]
    fn archived_v5(&self) -> &ArchivedJsCacheShardMachineV5 {
        unsafe {
            rkyv::access_unchecked::<ArchivedJsCacheShardMachineV5>(
                &self.mmap[SHARD_HEADER_BYTES..],
            )
        }
    }

    #[inline]
    pub fn entry_count(&self) -> usize {
        match self.header().version {
            1 => self.archived().entries.len(),
            2 => self.archived_v2().entries.len(),
            3 | 4 => self.archived_v3().entries.len(),
            5 => self.archived_v5().entries.len(),
            _ => {
                unreachable!("packed shard version is validated in TrustedPackedShardMachine::open")
            }
        }
    }

    fn machine_document_for_key(&self, key: &str) -> Option<&[u8]> {
        match self.header().version {
            2 => {
                let shard = self.archived_v2();
                let entry = shard
                    .entries
                    .binary_search_by(|entry| entry.key.as_str().cmp(key))
                    .ok()
                    .and_then(|index| shard.entries.get(index))?;
                entry
                    .machine_document
                    .as_ref()
                    .map(|document| document.as_slice())
            }
            3 | 4 => {
                let shard = self.archived_v3();
                let entry = shard
                    .entries
                    .binary_search_by(|entry| entry.key.as_str().cmp(key))
                    .ok()
                    .and_then(|index| shard.entries.get(index))?;
                entry
                    .machine_document
                    .as_ref()
                    .map(|document| document.as_slice())
            }
            5 => {
                let shard = self.archived_v5();
                let entry = shard
                    .entries
                    .binary_search_by(|entry| entry.key.as_str().cmp(key))
                    .ok()
                    .and_then(|index| shard.entries.get(index))?;
                entry
                    .machine_document
                    .as_ref()
                    .map(|document| document.as_slice())
            }
            _ => None,
        }
    }

    fn package_json_read_for_key(
        &self,
        key: &str,
        shard_entry_index: Option<u32>,
        source_bytes: Option<&[u8]>,
    ) -> Option<PackageJsonMachineRead> {
        let read_ref = self.package_json_read_ref_for_key(key, shard_entry_index, source_bytes)?;
        let read = read_ref.read;
        Some(PackageJsonMachineRead {
            name: read_ref.name().map(Box::from),
            version: read_ref.version().map(Box::from),
            module_type: read_ref.module_type().map(Box::from),
            main: read_ref.main().map(Box::from),
            module: read_ref.module().map(Box::from),
            browser: read_ref
                .browser()
                .and_then(package_json_read_value_ref_owned),
            jsnext_main: read_ref.jsnext_main().map(Box::from),
            side_effects: read_ref
                .side_effects()
                .and_then(package_json_read_value_ref_owned),
            exports: read_ref
                .exports()
                .and_then(package_json_read_value_ref_owned),
            imports: read_ref
                .imports()
                .and_then(package_json_read_value_ref_owned),
            mapped_bytes: read_ref.mapped_bytes(),
            context_key_count: package_json_read_key_count(read),
            shard_entry_count: read_ref.shard_entry_count(),
        })
    }

    fn package_json_read_ref_for_key(
        &self,
        key: &str,
        shard_entry_index: Option<u32>,
        source_bytes: Option<&[u8]>,
    ) -> Option<PackageJsonMachineReadRef<'_>> {
        if self.header().version != 5 {
            return None;
        }
        if !trust_package_json_read_enabled()
            && let Some(source_bytes) = source_bytes
        {
            if package_json_source_has_unsupported_read_keys(source_bytes) {
                return None;
            }
        }

        let shard = self.archived_v5();
        let entry = shard_entry_index
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| shard.entries.get(index))
            .filter(|entry| entry.key.as_str() == key)
            .or_else(|| {
                shard
                    .entries
                    .binary_search_by(|entry| entry.key.as_str().cmp(key))
                    .ok()
                    .and_then(|index| shard.entries.get(index))
            })?;
        let read = entry.package_json_read.as_ref()?;

        record_package_json_machine_cache_proof("packed_package_json_payload_hit", key.as_bytes());
        Some(PackageJsonMachineReadRef {
            read,
            mapped_bytes: self.mmap.len(),
            shard_entry_count: self.entry_count(),
            trusted_resolver_payload: source_bytes.is_none() || trust_package_json_read_enabled(),
        })
    }
}

fn package_json_read_key_count(read: &ArchivedPackageJsonReadMachine) -> usize {
    usize::from(read.name.is_some())
        + usize::from(read.version.is_some())
        + usize::from(read.module_type.is_some())
        + usize::from(read.main.is_some())
        + usize::from(read.module.is_some())
        + usize::from(read.browser.is_some())
        + usize::from(read.jsnext_main.is_some())
        + usize::from(read.side_effects.is_some())
        + usize::from(read.exports.is_some())
        + usize::from(read.imports.is_some())
}

fn package_json_read_value_at(
    read: &ArchivedPackageJsonReadMachine,
    index: usize,
) -> Option<PackageJsonMachineValue> {
    match read.value_arena.get(index)? {
        ArchivedPackageJsonReadMachineValue::Str(value) => Some(PackageJsonMachineValue::Str(
            Box::from(value.as_str().as_bytes()),
        )),
        ArchivedPackageJsonReadMachineValue::Bool(value) => {
            Some(PackageJsonMachineValue::Bool(*value))
        }
        ArchivedPackageJsonReadMachineValue::Null => Some(PackageJsonMachineValue::Null),
        ArchivedPackageJsonReadMachineValue::Arr(items) => {
            let mut output = Vec::with_capacity(items.len());
            for index in items.iter() {
                let index = usize::try_from(*index).ok()?;
                output.push(package_json_read_value_at(read, index)?);
            }
            Some(PackageJsonMachineValue::Arr(output))
        }
        ArchivedPackageJsonReadMachineValue::Obj(fields) => {
            let mut output = Vec::with_capacity(fields.len());
            for entry in fields.iter() {
                let index = usize::try_from(entry.1).ok()?;
                output.push((
                    Box::<[u8]>::from(entry.0.as_str().as_bytes()),
                    package_json_read_value_at(read, index)?,
                ));
            }
            Some(PackageJsonMachineValue::Obj(output))
        }
    }
}

fn package_json_read_value_ref_owned(
    value: PackageJsonMachineValueRef<'_>,
) -> Option<PackageJsonMachineValue> {
    match value.kind() {
        PackageJsonMachineValueKind::Str => {
            Some(PackageJsonMachineValue::Str(Box::from(value.as_str()?)))
        }
        PackageJsonMachineValueKind::Bool => Some(PackageJsonMachineValue::Bool(value.as_bool()?)),
        PackageJsonMachineValueKind::Null => Some(PackageJsonMachineValue::Null),
        PackageJsonMachineValueKind::Arr => {
            let len = value.array_len()?;
            let mut output = Vec::with_capacity(len);
            for index in 0..len {
                output.push(package_json_read_value_ref_owned(value.array_item(index)?)?);
            }
            Some(PackageJsonMachineValue::Arr(output))
        }
        PackageJsonMachineValueKind::Obj => {
            let len = value.object_len()?;
            let mut output = Vec::with_capacity(len);
            for index in 0..len {
                let (key, value) = value.object_field(index)?;
                output.push((Box::from(key), package_json_read_value_ref_owned(value)?));
            }
            Some(PackageJsonMachineValue::Obj(output))
        }
    }
}

fn mmap_file(path: &Path) -> Result<Mmap, DxMachineCacheError> {
    let file = File::open(path).map_err(|source| DxMachineCacheError::Open {
        path: path.display().to_string(),
        source,
    })?;
    unsafe {
        MmapOptions::new()
            .map_copy_read_only(&file)
            .map_err(|source| DxMachineCacheError::Mmap {
                path: path.display().to_string(),
                source,
            })
    }
}

fn read_machine_file(path: &Path) -> Result<TrustedMachineDocumentBacking, DxMachineCacheError> {
    if buffer_documents_enabled() {
        let bytes = std::fs::read(path).map_err(|source| DxMachineCacheError::Open {
            path: path.display().to_string(),
            source,
        })?;
        return Ok(TrustedMachineDocumentBacking::Bytes(
            bytes.into_boxed_slice(),
        ));
    }

    mmap_file(path).map(TrustedMachineDocumentBacking::Mmap)
}

fn validate_current_source(
    path: &Path,
    source_bytes: &[u8],
    entry: &TrustedCatalogEntry<'_>,
) -> Result<(), DxMachineCacheError> {
    if source_bytes.len() as u64 != entry.source_bytes {
        return Err(invalid(path, "source byte length mismatch"));
    }

    if !blake3_matches_hex(source_bytes, entry.source_blake3) {
        return Err(invalid(path, "source blake3 mismatch"));
    }

    Ok(())
}

fn read_current_source_validated(
    path: &Path,
    entry: &TrustedCatalogEntry<'_>,
) -> Result<Vec<u8>, DxMachineCacheError> {
    let source_bytes = std::fs::read(path).map_err(|source| DxMachineCacheError::Open {
        path: path.display().to_string(),
        source,
    })?;
    validate_current_source(path, &source_bytes, entry)?;
    Ok(source_bytes)
}

fn validate_current_source_metadata(
    path: &Path,
    entry: &TrustedCatalogEntry<'_>,
) -> Result<(), DxMachineCacheError> {
    let metadata = std::fs::metadata(path).map_err(|source| DxMachineCacheError::Open {
        path: path.display().to_string(),
        source,
    })?;

    if metadata.len() != entry.source_bytes {
        return Err(invalid(path, "source byte length mismatch"));
    }

    let Some(expected_modified_unix_ms) = entry.source_modified_unix_ms else {
        return Err(invalid(path, "source modified time missing"));
    };
    let modified = metadata
        .modified()
        .map_err(|_| invalid(path, "source modified time unavailable"))?;
    let modified_unix_ms = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid(path, "source modified time unavailable"))?
        .as_millis();
    let modified_unix_ms = u64::try_from(modified_unix_ms)
        .map_err(|_| invalid(path, "source modified time unavailable"))?;

    if modified_unix_ms > expected_modified_unix_ms {
        return Err(invalid(
            path,
            "source modified time newer than machine cache",
        ));
    }

    Ok(())
}

fn package_json_source_has_unsupported_read_keys(source_bytes: &[u8]) -> bool {
    let mut index = 0usize;
    let mut depth = 0usize;

    while index < source_bytes.len() {
        match source_bytes[index] {
            b'"' => {
                let Some((string_end, has_escape)) =
                    package_json_source_string_bounds(source_bytes, index + 1)
                else {
                    return true;
                };

                if depth == 1
                    && package_json_next_non_whitespace(source_bytes, string_end + 1) == Some(b':')
                {
                    if has_escape {
                        return true;
                    }
                }

                index = string_end + 1;
            }
            b'{' | b'[' => {
                depth = depth.saturating_add(1);
                index += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            _ => {
                index += 1;
            }
        }
    }

    false
}

fn package_json_source_string_bounds(
    source_bytes: &[u8],
    mut index: usize,
) -> Option<(usize, bool)> {
    let mut has_escape = false;
    while index < source_bytes.len() {
        match source_bytes[index] {
            b'\\' => {
                has_escape = true;
                index = index.checked_add(2)?;
            }
            b'"' => return Some((index, has_escape)),
            _ => index += 1,
        }
    }

    None
}

fn package_json_next_non_whitespace(source_bytes: &[u8], mut index: usize) -> Option<u8> {
    while index < source_bytes.len() {
        let byte = source_bytes[index];
        if !matches!(byte, b' ' | b'\n' | b'\r' | b'\t') {
            return Some(byte);
        }
        index += 1;
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{
        ArchivedJsCacheShardMachineV5, DxJsMachineCachePackedShardHeader,
        JsCacheShardEntryMachineV5, JsCacheShardMachineV5, PackageJsonReadMachine,
        PackageJsonReadMachineValue, SHARD_HEADER_BYTES, SHARD_MACHINE_SCHEMA_V5, SHARD_MAGIC,
        TrustedPackedShardMachine, catalog_entry_shard_base_from_parts, catalog_source_path,
        node_modules_package_json_name, node_modules_package_json_source_name,
        package_json_read_identity, package_json_source_has_unsupported_read_keys,
        path_from_utf8_bytes, repo_relative_source,
    };
    use std::io::Write;
    use std::path::Path;

    #[test]
    fn package_json_read_allows_top_level_resolver_fields() {
        for key in ["main", "module", "browser", "jsnext:main", "sideEffects"] {
            let source = format!(r#"{{ "name": "pkg", "{key}": "./index.js" }}"#);
            assert!(
                !package_json_source_has_unsupported_read_keys(source.as_bytes()),
                "expected top-level {key} to use resolver-ready machine payload"
            );
        }
    }

    #[test]
    fn package_json_read_allows_nested_conditions_and_string_values() {
        let source = br##"{
            "name": "pkg",
            "type": "module",
            "exports": {
                ".": {
                    "browser": "./browser.js",
                    "import": "./index.js"
                }
            },
            "imports": {
                "#browser": "./browser.js"
            }
        }"##;

        assert!(!package_json_source_has_unsupported_read_keys(source));
    }

    #[test]
    fn package_json_read_rejects_escaped_top_level_keys_conservatively() {
        let source = br#"{ "name": "pkg", "ma\u0069n": "./index.js" }"#;

        assert!(package_json_source_has_unsupported_read_keys(source));
    }

    #[test]
    fn catalog_shard_base_accepts_safe_coalesced_prefix_depths() {
        let path = Path::new("catalog.machine");
        let source_blake3 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

        assert_eq!(
            catalog_entry_shard_base_from_parts(
                path,
                "package_json",
                source_blake3,
                "package_json/0123456789abcdef"
            )
            .expect("zero-prefix shard"),
            "package_json"
        );
        assert_eq!(
            catalog_entry_shard_base_from_parts(
                path,
                "package_json",
                source_blake3,
                "package_json/a/0123456789abcdef"
            )
            .expect("one-prefix shard"),
            "package_json/a"
        );
        assert_eq!(
            catalog_entry_shard_base_from_parts(
                path,
                "package_json",
                source_blake3,
                "package_json/ab/0123456789abcdef"
            )
            .expect("two-prefix shard"),
            "package_json/ab"
        );
    }

    #[test]
    fn catalog_shard_base_rejects_prefixes_that_do_not_match_source_hash() {
        let path = Path::new("catalog.machine");
        let source_blake3 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

        assert!(
            catalog_entry_shard_base_from_parts(
                path,
                "package_json",
                source_blake3,
                "package_json/ff/0123456789abcdef"
            )
            .is_err()
        );
    }

    #[test]
    fn path_from_utf8_bytes_borrows_path_without_pathbuf_allocation() {
        let path = path_from_utf8_bytes(br"G:\repo\package.json").expect("utf8 path");

        assert_eq!(path, Path::new(r"G:\repo\package.json"));
    }

    #[test]
    fn repo_relative_source_normalizes_windows_components() {
        let root = Path::new(r"G:\repo");
        let source_path = Path::new(r"G:\repo\node_modules\pkg\package.json");

        assert_eq!(
            repo_relative_source(root, source_path).as_deref(),
            Some("node_modules/pkg/package.json")
        );
    }

    #[test]
    fn catalog_source_path_builds_absolute_package_json_index_keys() {
        let root = Path::new(r"G:\repo");

        assert_eq!(
            catalog_source_path(root, "node_modules/pkg/package.json").as_deref(),
            Some(Path::new(r"G:\repo\node_modules\pkg\package.json"))
        );
        assert!(catalog_source_path(root, "../package.json").is_none());
        assert!(catalog_source_path(root, r"node_modules\pkg\package.json").is_none());
    }

    #[test]
    fn node_modules_package_json_name_extracts_top_level_unscoped_packages() {
        let root = Path::new(r"G:\repo");

        assert_eq!(
            node_modules_package_json_name(
                root,
                Path::new(r"G:\repo\node_modules\pkg\package.json")
            ),
            Some("pkg")
        );
        assert_eq!(
            node_modules_package_json_source_name("node_modules/pkg/package.json"),
            Some("pkg")
        );
        assert!(
            node_modules_package_json_name(root, Path::new(r"G:\repo\node_modules\pkg\index.ts"))
                .is_none()
        );
        assert!(
            node_modules_package_json_source_name("node_modules/@scope/pkg/package.json").is_none()
        );
    }

    #[test]
    fn packed_v5_package_json_read_payload_opens_without_document_decode() {
        let key = "package_json\0package.json";
        let source_blake3 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let machine_document = b"dx-machine-document-envelope".to_vec();
        let machine_blake3 = blake3::hash(&machine_document).to_hex().to_string();
        let shard = "package_json/aa/v5-test";

        let body = package_json_read_test_body(shard, key, source_blake3, &machine_blake3, "pkg");
        let package_json_read_identity = test_package_json_read_identity(&body);

        let mut identity_input = String::new();
        identity_input.push_str(key);
        identity_input.push('\0');
        identity_input.push_str(source_blake3);
        identity_input.push('\0');
        identity_input.push_str(&machine_blake3);
        identity_input.push('\0');
        identity_input.push_str(&package_json_read_identity);
        identity_input.push('\0');
        let mut machine_identity_input =
            String::with_capacity("machine:".len() + identity_input.len());
        machine_identity_input.push_str("machine:");
        machine_identity_input.push_str(&identity_input);

        let header = DxJsMachineCachePackedShardHeader {
            magic: SHARD_MAGIC,
            version: 5,
            header_bytes: SHARD_HEADER_BYTES as u32,
            kind_id: 1,
            entry_count: 1,
            source_bytes: 48,
            machine_bytes: machine_document.len() as u64,
            metadata_bytes: 0,
            shard_path_blake3: blake3::hash(b".dx/js/shards/package_json/aa/v5-test.dxjs").into(),
            source_identity_blake3: blake3::hash(identity_input.as_bytes()).into(),
            machine_identity_blake3: blake3::hash(machine_identity_input.as_bytes()).into(),
            reserved: [0; 16],
        };

        let root =
            std::env::temp_dir().join(format!("bun-dx-machine-cache-v5-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp root");
        let path = root.join("v5.dxjs");
        let mut file = std::fs::File::create(&path).expect("create v5 shard");
        file.write_all(bytemuck::bytes_of(&header))
            .expect("write v5 header");
        file.write_all(body.as_ref()).expect("write v5 body");
        drop(file);

        let shard = TrustedPackedShardMachine::open(&path).expect("open v5 shard");
        let read = shard
            .package_json_read_for_key(
                key,
                Some(0),
                Some(br#"{"name":"pkg","exports":{".":"./index.ts"}}"#),
            )
            .expect("read v5 package-json payload");

        assert_eq!(read.name.as_deref(), Some(b"pkg".as_slice()));
        assert_eq!(read.version.as_deref(), Some(b"1.0.0".as_slice()));
        assert_eq!(read.module_type.as_deref(), Some(b"module".as_slice()));
        assert_eq!(read.main.as_deref(), Some(b"./index.cjs".as_slice()));
        assert_eq!(read.module.as_deref(), Some(b"./index.mjs".as_slice()));
        assert!(read.browser.is_some());
        assert!(read.side_effects.is_some());
        assert!(read.exports.is_some());
        assert_eq!(read.shard_entry_count, 1);

        std::fs::remove_dir_all(root).expect("remove temp root");
    }

    #[test]
    fn packed_v5_package_json_read_payload_is_identity_bound() {
        let key = "package_json\0package.json";
        let source_blake3 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let machine_document = b"dx-machine-document-envelope".to_vec();
        let machine_blake3 = blake3::hash(&machine_document).to_hex().to_string();
        let shard = "package_json/aa/v5-tamper-test";

        let trusted_body =
            package_json_read_test_body(shard, key, source_blake3, &machine_blake3, "pkg");
        let tampered_body =
            package_json_read_test_body(shard, key, source_blake3, &machine_blake3, "evil");
        let package_json_read_identity = test_package_json_read_identity(&trusted_body);

        let mut identity_input = String::new();
        identity_input.push_str(key);
        identity_input.push('\0');
        identity_input.push_str(source_blake3);
        identity_input.push('\0');
        identity_input.push_str(&machine_blake3);
        identity_input.push('\0');
        identity_input.push_str(&package_json_read_identity);
        identity_input.push('\0');
        let machine_identity_input = format!("machine:{identity_input}");

        let header = DxJsMachineCachePackedShardHeader {
            magic: SHARD_MAGIC,
            version: 5,
            header_bytes: SHARD_HEADER_BYTES as u32,
            kind_id: 1,
            entry_count: 1,
            source_bytes: 48,
            machine_bytes: machine_document.len() as u64,
            metadata_bytes: 0,
            shard_path_blake3: blake3::hash(b".dx/js/shards/package_json/aa/v5-tamper-test.dxjs")
                .into(),
            source_identity_blake3: blake3::hash(identity_input.as_bytes()).into(),
            machine_identity_blake3: blake3::hash(machine_identity_input.as_bytes()).into(),
            reserved: [0; 16],
        };

        let root = std::env::temp_dir().join(format!(
            "bun-dx-machine-cache-v5-tamper-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp root");
        let path = root.join("v5-tamper.dxjs");
        let mut file = std::fs::File::create(&path).expect("create v5 shard");
        file.write_all(bytemuck::bytes_of(&header))
            .expect("write v5 header");
        file.write_all(tampered_body.as_ref())
            .expect("write tampered v5 body");
        drop(file);

        assert!(TrustedPackedShardMachine::open(&path).is_err());

        std::fs::remove_dir_all(root).expect("remove temp root");
    }

    fn package_json_read_test_body(
        shard: &str,
        key: &str,
        source_blake3: &str,
        machine_blake3: &str,
        name: &str,
    ) -> rkyv::util::AlignedVec {
        let shard_machine = JsCacheShardMachineV5 {
            schema: SHARD_MACHINE_SCHEMA_V5.to_string(),
            shard: shard.to_string(),
            entries: vec![JsCacheShardEntryMachineV5 {
                key: key.to_string(),
                source: "package.json".to_string(),
                machine: ".dx/js/package-json.machine".to_string(),
                metadata: ".dx/js/package-json.machine.meta.json".to_string(),
                key_interning: None,
                source_blake3: source_blake3.to_string(),
                machine_blake3: machine_blake3.to_string(),
                machine_document: Some(b"dx-machine-document-envelope".to_vec()),
                package_json_read: Some(PackageJsonReadMachine {
                    name: Some(name.to_string()),
                    version: Some("1.0.0".to_string()),
                    module_type: Some("module".to_string()),
                    main: Some("./index.cjs".to_string()),
                    module: Some("./index.mjs".to_string()),
                    browser: Some(0),
                    jsnext_main: None,
                    side_effects: Some(2),
                    exports: Some(3),
                    imports: None,
                    value_arena: vec![
                        PackageJsonReadMachineValue::Obj(vec![("./index.cjs".to_string(), 1)]),
                        PackageJsonReadMachineValue::Str("./browser.ts".to_string()),
                        PackageJsonReadMachineValue::Bool(false),
                        PackageJsonReadMachineValue::Obj(vec![(".".to_string(), 4)]),
                        PackageJsonReadMachineValue::Str("./index.ts".to_string()),
                    ],
                }),
            }],
        };
        rkyv::to_bytes::<rkyv::rancor::Error>(&shard_machine).expect("serialize v5 shard")
    }

    fn test_package_json_read_identity(body: &[u8]) -> String {
        let archived = rkyv::access::<ArchivedJsCacheShardMachineV5, rkyv::rancor::Error>(body)
            .expect("access v5 shard");
        let read = archived
            .entries
            .get(0)
            .and_then(|entry| entry.package_json_read.as_ref())
            .expect("package-json read payload");
        package_json_read_identity(Path::new("test.dxjs"), read)
            .expect("hash package-json read payload")
            .to_hex()
            .to_string()
    }
}

fn bytecheck_catalog(path: &Path, bytes: &[u8]) -> Result<(), DxMachineCacheError> {
    rkyv::access::<ArchivedJsCacheCatalogMachine, rkyv::rancor::Error>(bytes)
        .map(|_| ())
        .map_err(|source| DxMachineCacheError::Bytecheck {
            path: path.display().to_string(),
            source,
        })
}

fn bytecheck_shard(path: &Path, bytes: &[u8]) -> Result<(), DxMachineCacheError> {
    rkyv::access::<ArchivedJsCacheShardMachine, rkyv::rancor::Error>(bytes)
        .map(|_| ())
        .map_err(|source| DxMachineCacheError::Bytecheck {
            path: path.display().to_string(),
            source,
        })
}

fn bytecheck_shard_v2(path: &Path, bytes: &[u8]) -> Result<(), DxMachineCacheError> {
    rkyv::access::<ArchivedJsCacheShardMachineV2, rkyv::rancor::Error>(bytes)
        .map(|_| ())
        .map_err(|source| DxMachineCacheError::Bytecheck {
            path: path.display().to_string(),
            source,
        })
}

fn bytecheck_shard_v3(path: &Path, bytes: &[u8]) -> Result<(), DxMachineCacheError> {
    rkyv::access::<ArchivedJsCacheShardMachineV3, rkyv::rancor::Error>(bytes)
        .map(|_| ())
        .map_err(|source| DxMachineCacheError::Bytecheck {
            path: path.display().to_string(),
            source,
        })
}

fn bytecheck_shard_v5(path: &Path, bytes: &[u8]) -> Result<(), DxMachineCacheError> {
    rkyv::access::<ArchivedJsCacheShardMachineV5, rkyv::rancor::Error>(bytes)
        .map(|_| ())
        .map_err(|source| DxMachineCacheError::Bytecheck {
            path: path.display().to_string(),
            source,
        })
}

fn decode_machine_envelope_payload_bounds(
    path: &Path,
    bytes: &[u8],
) -> Result<(usize, usize), DxMachineCacheError> {
    if !bytes.starts_with(&MACHINE_ENVELOPE_MAGIC) {
        rkyv::access::<ArchivedDxMachineDocument, rkyv::rancor::Error>(bytes).map_err(
            |source| DxMachineCacheError::Bytecheck {
                path: path.display().to_string(),
                source,
            },
        )?;
        return Ok((0, bytes.len()));
    }

    if bytes.len() < MACHINE_ENVELOPE_HEADER_LEN {
        return Err(invalid(path, "machine envelope is smaller than header"));
    }

    if bytes[4] != MACHINE_ENVELOPE_VERSION {
        return Err(invalid(path, "machine envelope version mismatch"));
    }

    if bytes[5] != MACHINE_ENVELOPE_CODEC_NONE {
        return Err(invalid(
            path,
            "compressed machine envelope requires serializer fallback",
        ));
    }

    if bytes[6] != 0 || bytes[7] != 0 {
        return Err(invalid(path, "machine envelope reserved bytes mismatch"));
    }

    let payload_len = usize_from_u64(read_u64_le(path, &bytes[8..16])?, path)?;
    let uncompressed_len = usize_from_u64(read_u64_le(path, &bytes[16..24])?, path)?;
    let expected_len = MACHINE_ENVELOPE_HEADER_LEN
        .checked_add(payload_len)
        .ok_or_else(|| invalid(path, "machine envelope length overflow"))?;

    if bytes.len() != expected_len {
        return Err(invalid(path, "machine envelope length mismatch"));
    }

    if payload_len != uncompressed_len {
        return Err(invalid(
            path,
            "uncompressed machine envelope length mismatch",
        ));
    }

    let payload = &bytes[MACHINE_ENVELOPE_HEADER_LEN..];
    if blake3::hash(payload).as_bytes() != &bytes[24..56] {
        return Err(invalid(path, "machine envelope payload blake3 mismatch"));
    }

    rkyv::access::<ArchivedDxMachineDocument, rkyv::rancor::Error>(payload).map_err(|source| {
        DxMachineCacheError::Bytecheck {
            path: path.display().to_string(),
            source,
        }
    })?;

    Ok((MACHINE_ENVELOPE_HEADER_LEN, payload_len))
}

fn packed_shard_header(
    bytes: &[u8],
) -> Result<&DxJsMachineCachePackedShardHeader, DxMachineCacheError> {
    if bytes.len() != SHARD_HEADER_BYTES {
        return Err(DxMachineCacheError::Invalid {
            path: "<memory>".to_string(),
            reason: "packed shard header length mismatch",
        });
    }
    if std::mem::size_of::<DxJsMachineCachePackedShardHeader>() != SHARD_HEADER_BYTES {
        return Err(DxMachineCacheError::Invalid {
            path: "<memory>".to_string(),
            reason: "packed shard header struct size mismatch",
        });
    }
    bytemuck::try_from_bytes(bytes).map_err(|_| DxMachineCacheError::Invalid {
        path: "<memory>".to_string(),
        reason: "packed shard header alignment mismatch",
    })
}

fn validate_catalog(
    path: &Path,
    catalog: &ArchivedJsCacheCatalogMachine,
) -> Result<(), DxMachineCacheError> {
    let entries = &catalog.entries;
    let mut previous_key: Option<&str> = None;
    let mut expected_shards = Vec::with_capacity(entries.len());
    let mut shard_groups: BTreeMap<String, Vec<&ArchivedJsCacheCatalogEntryMachine>> =
        BTreeMap::new();

    for entry in entries.iter() {
        let key = entry.key.as_str();
        if previous_key.is_some_and(|previous| previous >= key) {
            return Err(invalid(
                path,
                "catalog entries are not sorted by unique key",
            ));
        }
        previous_key = Some(key);

        let shard_base = validate_catalog_entry(path, entry)?;
        expected_shards.push(entry.shard.as_str());
        shard_groups.entry(shard_base).or_default().push(entry);
    }

    validate_catalog_shard_content_ids(path, &shard_groups)?;

    expected_shards.sort_unstable();
    expected_shards.dedup();

    let mut catalog_shards = Vec::with_capacity(catalog.shards.len());
    let mut previous_shard: Option<&str> = None;
    for shard in catalog.shards.iter() {
        let shard = shard.as_str();
        if !is_safe_repo_relative_path(shard) {
            return Err(invalid(path, "catalog shard path is not repo-relative"));
        }
        if previous_shard.is_some_and(|previous| previous >= shard) {
            return Err(invalid(
                path,
                "catalog shards are not sorted by unique path",
            ));
        }
        previous_shard = Some(shard);
        catalog_shards.push(shard);
    }

    if catalog_shards != expected_shards {
        return Err(invalid(path, "catalog shards do not match entries"));
    }

    if catalog.lookup.len() != entries.len() {
        return Err(invalid(path, "catalog lookup length mismatch"));
    }

    let mut seen = vec![false; entries.len()];
    let mut previous_lookup_key: Option<&str> = None;
    for lookup in catalog.lookup.iter() {
        let lookup_key = lookup.key.as_str();
        if previous_lookup_key.is_some_and(|previous| previous >= lookup_key) {
            return Err(invalid(path, "catalog lookup is not sorted by unique key"));
        }
        previous_lookup_key = Some(lookup_key);

        let index = usize::try_from(lookup.index.to_native())
            .map_err(|_| invalid(path, "catalog lookup index overflow"))?;
        let Some(entry) = entries.get(index) else {
            return Err(invalid(path, "catalog lookup index out of range"));
        };
        if seen[index] {
            return Err(invalid(path, "catalog lookup duplicate index"));
        }
        if lookup_key != entry.key.as_str() {
            return Err(invalid(path, "catalog lookup key mismatch"));
        }
        seen[index] = true;
    }

    Ok(())
}

fn catalog_entry_shard_base(
    path: &Path,
    entry: &ArchivedJsCacheCatalogEntryMachine,
) -> Result<String, DxMachineCacheError> {
    catalog_entry_shard_base_from_parts(
        path,
        entry.kind.as_str(),
        entry.source_blake3.as_str(),
        entry.shard.as_str(),
    )
}

fn catalog_entry_shard_base_from_parts(
    path: &Path,
    kind: &str,
    source_blake3: &str,
    shard: &str,
) -> Result<String, DxMachineCacheError> {
    let mut parts = shard.split('/');
    let Some(shard_kind) = parts.next() else {
        return Err(invalid(path, "catalog entry shard mismatch"));
    };
    if shard_kind != kind {
        return Err(invalid(path, "catalog entry shard kind mismatch"));
    }

    let Some(first_part) = parts.next() else {
        return Err(invalid(path, "catalog entry shard mismatch"));
    };
    let second_part = parts.next();
    if parts.next().is_some() {
        return Err(invalid(path, "catalog entry shard mismatch"));
    }

    let Some(content_id) = second_part else {
        if !is_lower_hex(first_part, 16) {
            return Err(invalid(path, "catalog entry shard mismatch"));
        }

        return Ok(kind.to_string());
    };

    if first_part.is_empty()
        || first_part.len() > 64
        || !is_lower_hex_prefix(first_part)
        || !source_blake3.starts_with(first_part)
    {
        return Err(invalid(path, "catalog entry shard source prefix mismatch"));
    }
    if !is_lower_hex(content_id, 16) {
        return Err(invalid(path, "catalog entry shard mismatch"));
    }

    Ok(format!("{kind}/{first_part}"))
}

fn validate_catalog_shard_content_ids(
    path: &Path,
    shard_groups: &BTreeMap<String, Vec<&ArchivedJsCacheCatalogEntryMachine>>,
) -> Result<(), DxMachineCacheError> {
    for (base_shard, entries) in shard_groups {
        let expected_shard = format!("{}/{}", base_shard, shard_content_id(entries));
        for entry in entries {
            if entry.shard.as_str() != expected_shard {
                return Err(invalid(path, "catalog entry shard content id mismatch"));
            }
        }
    }

    Ok(())
}

fn shard_content_id(entries: &[&ArchivedJsCacheCatalogEntryMachine]) -> String {
    let mut hasher = Sha256::new();
    for entry in entries {
        hasher.update(entry.key.as_str().as_bytes());
        hasher.update([0]);
        hasher.update(entry.source_blake3.as_str().as_bytes());
        hasher.update([0]);
        hasher.update(entry.machine_blake3.as_str().as_bytes());
        hasher.update([0]);
    }

    let digest = hasher.finalize();
    first_16_lower_hex(&digest[..])
}

fn first_16_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(16);
    for byte in bytes.iter().take(8) {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn validate_catalog_entry(
    path: &Path,
    entry: &ArchivedJsCacheCatalogEntryMachine,
) -> Result<String, DxMachineCacheError> {
    let kind = entry.kind.as_str();
    let source = entry.source.as_str();
    let shard = entry.shard.as_str();
    let machine = entry.machine.as_str();
    let metadata = entry.metadata.as_str();
    let key_interning = entry.key_interning.as_ref().map(|value| value.as_str());
    let source_blake3 = entry.source_blake3.as_str();
    let machine_blake3 = entry.machine_blake3.as_str();

    validate_cache_key(path, entry.key.as_str(), kind, source)?;
    if !is_safe_cache_kind(kind) {
        return Err(invalid(path, "catalog entry kind is not canonical"));
    }
    if !is_safe_repo_relative_path(source)
        || !is_safe_repo_relative_path(machine)
        || !is_safe_repo_relative_path(metadata)
        || !is_safe_repo_relative_path(shard)
    {
        return Err(invalid(path, "catalog entry path is not repo-relative"));
    }
    if key_interning.is_some_and(|value| !is_safe_repo_relative_path(value)) {
        return Err(invalid(
            path,
            "catalog entry key interning path is not repo-relative",
        ));
    }
    if !is_lower_hex_64(source_blake3) || !is_lower_hex_64(machine_blake3) {
        return Err(invalid(path, "catalog entry blake3 is not lowercase hex"));
    }

    catalog_entry_shard_base(path, entry)
}

fn validate_packed_shard(
    path: &Path,
    header: &DxJsMachineCachePackedShardHeader,
    shard: &ArchivedJsCacheShardMachine,
) -> Result<(), DxMachineCacheError> {
    if header.reserved.iter().any(|byte| *byte != 0) {
        return Err(invalid(path, "packed shard reserved bytes mismatch"));
    }

    let entries = &shard.entries;
    if header.entry_count as usize != entries.len() {
        return Err(invalid(path, "packed shard entry count mismatch"));
    }
    if entries.is_empty() {
        return Err(invalid(path, "packed shard has no entries"));
    }
    if !is_safe_repo_relative_path(shard.shard.as_str()) {
        return Err(invalid(path, "packed shard path is not repo-relative"));
    }
    let shard_path_identity = packed_shard_path_identity_input(shard.shard.as_str());
    if blake3::hash(shard_path_identity.as_bytes()).as_bytes() != &header.shard_path_blake3 {
        return Err(invalid(path, "packed shard path identity mismatch"));
    }

    let mut previous_key: Option<&str> = None;
    let mut shard_kind: Option<&str> = None;
    let mut identity_input = String::new();

    for entry in entries.iter() {
        let key = entry.key.as_str();
        if previous_key.is_some_and(|previous| previous >= key) {
            return Err(invalid(
                path,
                "packed shard entries are not sorted by unique key",
            ));
        }
        previous_key = Some(key);

        let Some((kind, source_from_key)) = split_cache_key(key) else {
            return Err(invalid(path, "packed shard entry key is not canonical"));
        };
        if !is_safe_cache_kind(kind) || !is_safe_repo_relative_path(source_from_key) {
            return Err(invalid(path, "packed shard entry key is not canonical"));
        }
        match shard_kind {
            Some(previous) if previous != kind => {
                return Err(invalid(path, "packed shard mixes entry kinds"));
            }
            None => shard_kind = Some(kind),
            _ => {}
        }

        validate_cache_key(path, key, kind, entry.source.as_str())?;
        if !is_safe_repo_relative_path(entry.source.as_str())
            || !is_safe_repo_relative_path(entry.machine.as_str())
            || !is_safe_repo_relative_path(entry.metadata.as_str())
        {
            return Err(invalid(
                path,
                "packed shard entry path is not repo-relative",
            ));
        }
        if entry
            .key_interning
            .as_ref()
            .is_some_and(|value| !is_safe_repo_relative_path(value.as_str()))
        {
            return Err(invalid(
                path,
                "packed shard key interning path is not repo-relative",
            ));
        }
        if !is_lower_hex_64(entry.source_blake3.as_str())
            || !is_lower_hex_64(entry.machine_blake3.as_str())
        {
            return Err(invalid(
                path,
                "packed shard entry blake3 is not lowercase hex",
            ));
        }

        identity_input.push_str(key);
        identity_input.push('\0');
        identity_input.push_str(entry.source_blake3.as_str());
        identity_input.push('\0');
        identity_input.push_str(entry.machine_blake3.as_str());
        identity_input.push('\0');
    }

    let kind = shard_kind.ok_or_else(|| invalid(path, "packed shard has no entry kind"))?;
    let Some(kind_id) = packed_shard_kind_id(kind) else {
        return Err(invalid(path, "packed shard kind is not canonical"));
    };
    if header.kind_id != kind_id {
        return Err(invalid(path, "packed shard kind id mismatch"));
    }
    if blake3::hash(identity_input.as_bytes()).as_bytes() != &header.source_identity_blake3 {
        return Err(invalid(path, "packed shard source identity mismatch"));
    }

    let mut machine_identity_input = String::with_capacity("machine:".len() + identity_input.len());
    machine_identity_input.push_str("machine:");
    machine_identity_input.push_str(&identity_input);
    if blake3::hash(machine_identity_input.as_bytes()).as_bytes() != &header.machine_identity_blake3
    {
        return Err(invalid(path, "packed shard machine identity mismatch"));
    }

    Ok(())
}

fn validate_packed_shard_v2(
    path: &Path,
    header: &DxJsMachineCachePackedShardHeader,
    shard: &ArchivedJsCacheShardMachineV2,
) -> Result<(), DxMachineCacheError> {
    if header.reserved.iter().any(|byte| *byte != 0) {
        return Err(invalid(path, "packed shard reserved bytes mismatch"));
    }

    let entries = &shard.entries;
    if header.entry_count as usize != entries.len() {
        return Err(invalid(path, "packed shard entry count mismatch"));
    }
    if entries.is_empty() {
        return Err(invalid(path, "packed shard has no entries"));
    }
    if !is_safe_repo_relative_path(shard.shard.as_str()) {
        return Err(invalid(path, "packed shard path is not repo-relative"));
    }
    let shard_path_identity = packed_shard_path_identity_input(shard.shard.as_str());
    if blake3::hash(shard_path_identity.as_bytes()).as_bytes() != &header.shard_path_blake3 {
        return Err(invalid(path, "packed shard path identity mismatch"));
    }

    let mut previous_key: Option<&str> = None;
    let mut shard_kind: Option<&str> = None;
    let mut identity_input = String::new();

    for entry in entries.iter() {
        let key = entry.key.as_str();
        if previous_key.is_some_and(|previous| previous >= key) {
            return Err(invalid(
                path,
                "packed shard entries are not sorted by unique key",
            ));
        }
        previous_key = Some(key);

        let Some((kind, source_from_key)) = split_cache_key(key) else {
            return Err(invalid(path, "packed shard entry key is not canonical"));
        };
        if !is_safe_cache_kind(kind) || !is_safe_repo_relative_path(source_from_key) {
            return Err(invalid(path, "packed shard entry key is not canonical"));
        }
        match shard_kind {
            Some(previous) if previous != kind => {
                return Err(invalid(path, "packed shard mixes entry kinds"));
            }
            None => shard_kind = Some(kind),
            _ => {}
        }

        validate_cache_key(path, key, kind, entry.source.as_str())?;
        if !is_safe_repo_relative_path(entry.source.as_str())
            || !is_safe_repo_relative_path(entry.machine.as_str())
            || !is_safe_repo_relative_path(entry.metadata.as_str())
        {
            return Err(invalid(
                path,
                "packed shard entry path is not repo-relative",
            ));
        }
        if entry
            .key_interning
            .as_ref()
            .is_some_and(|value| !is_safe_repo_relative_path(value.as_str()))
        {
            return Err(invalid(
                path,
                "packed shard key interning path is not repo-relative",
            ));
        }
        if !is_lower_hex_64(entry.source_blake3.as_str())
            || !is_lower_hex_64(entry.machine_blake3.as_str())
        {
            return Err(invalid(
                path,
                "packed shard entry blake3 is not lowercase hex",
            ));
        }

        match (kind, entry.machine_document.as_ref()) {
            ("package_json", Some(document)) => {
                if !blake3_matches_hex(document.as_slice(), entry.machine_blake3.as_str()) {
                    return Err(invalid(
                        path,
                        "packed shard machine document blake3 mismatch",
                    ));
                }
            }
            ("package_json", None) => {
                return Err(invalid(path, "packed shard missing machine document"));
            }
            (_, Some(_)) => {
                return Err(invalid(path, "packed shard unexpected machine document"));
            }
            (_, None) => {}
        }

        identity_input.push_str(key);
        identity_input.push('\0');
        identity_input.push_str(entry.source_blake3.as_str());
        identity_input.push('\0');
        identity_input.push_str(entry.machine_blake3.as_str());
        identity_input.push('\0');
    }

    let kind = shard_kind.ok_or_else(|| invalid(path, "packed shard has no entry kind"))?;
    let Some(kind_id) = packed_shard_kind_id(kind) else {
        return Err(invalid(path, "packed shard kind is not canonical"));
    };
    if header.kind_id != kind_id {
        return Err(invalid(path, "packed shard kind id mismatch"));
    }
    if blake3::hash(identity_input.as_bytes()).as_bytes() != &header.source_identity_blake3 {
        return Err(invalid(path, "packed shard source identity mismatch"));
    }

    let mut machine_identity_input = String::with_capacity("machine:".len() + identity_input.len());
    machine_identity_input.push_str("machine:");
    machine_identity_input.push_str(&identity_input);
    if blake3::hash(machine_identity_input.as_bytes()).as_bytes() != &header.machine_identity_blake3
    {
        return Err(invalid(path, "packed shard machine identity mismatch"));
    }

    Ok(())
}

fn validate_packed_shard_v3(
    path: &Path,
    header: &DxJsMachineCachePackedShardHeader,
    shard: &ArchivedJsCacheShardMachineV3,
) -> Result<(), DxMachineCacheError> {
    validate_packed_shard_with_package_read_v4(path, header, shard, false)
}

fn validate_packed_shard_v4(
    path: &Path,
    header: &DxJsMachineCachePackedShardHeader,
    shard: &ArchivedJsCacheShardMachineV3,
) -> Result<(), DxMachineCacheError> {
    validate_packed_shard_with_package_read_v4(path, header, shard, true)
}

fn validate_packed_shard_v5(
    path: &Path,
    header: &DxJsMachineCachePackedShardHeader,
    shard: &ArchivedJsCacheShardMachineV5,
) -> Result<(), DxMachineCacheError> {
    validate_packed_shard_with_package_read_v5(path, header, shard)
}

fn validate_packed_shard_with_package_read_v4(
    path: &Path,
    header: &DxJsMachineCachePackedShardHeader,
    shard: &ArchivedJsCacheShardMachineV3,
    include_package_read_identity: bool,
) -> Result<(), DxMachineCacheError> {
    if header.reserved.iter().any(|byte| *byte != 0) {
        return Err(invalid(path, "packed shard reserved bytes mismatch"));
    }

    let entries = &shard.entries;
    if header.entry_count as usize != entries.len() {
        return Err(invalid(path, "packed shard entry count mismatch"));
    }
    if entries.is_empty() {
        return Err(invalid(path, "packed shard has no entries"));
    }
    if !is_safe_repo_relative_path(shard.shard.as_str()) {
        return Err(invalid(path, "packed shard path is not repo-relative"));
    }
    let shard_path_identity = packed_shard_path_identity_input(shard.shard.as_str());
    if blake3::hash(shard_path_identity.as_bytes()).as_bytes() != &header.shard_path_blake3 {
        return Err(invalid(path, "packed shard path identity mismatch"));
    }

    let mut previous_key: Option<&str> = None;
    let mut shard_kind: Option<&str> = None;
    let mut identity_input = String::new();

    for entry in entries.iter() {
        let key = entry.key.as_str();
        if previous_key.is_some_and(|previous| previous >= key) {
            return Err(invalid(
                path,
                "packed shard entries are not sorted by unique key",
            ));
        }
        previous_key = Some(key);

        let Some((kind, source_from_key)) = split_cache_key(key) else {
            return Err(invalid(path, "packed shard entry key is not canonical"));
        };
        if !is_safe_cache_kind(kind) || !is_safe_repo_relative_path(source_from_key) {
            return Err(invalid(path, "packed shard entry key is not canonical"));
        }
        match shard_kind {
            Some(previous) if previous != kind => {
                return Err(invalid(path, "packed shard mixes entry kinds"));
            }
            None => shard_kind = Some(kind),
            _ => {}
        }

        validate_cache_key(path, key, kind, entry.source.as_str())?;
        if !is_safe_repo_relative_path(entry.source.as_str())
            || !is_safe_repo_relative_path(entry.machine.as_str())
            || !is_safe_repo_relative_path(entry.metadata.as_str())
        {
            return Err(invalid(
                path,
                "packed shard entry path is not repo-relative",
            ));
        }
        if entry
            .key_interning
            .as_ref()
            .is_some_and(|value| !is_safe_repo_relative_path(value.as_str()))
        {
            return Err(invalid(
                path,
                "packed shard key interning path is not repo-relative",
            ));
        }
        if !is_lower_hex_64(entry.source_blake3.as_str())
            || !is_lower_hex_64(entry.machine_blake3.as_str())
        {
            return Err(invalid(
                path,
                "packed shard entry blake3 is not lowercase hex",
            ));
        }

        match (kind, entry.machine_document.as_ref()) {
            ("package_json", Some(document)) => {
                if !blake3_matches_hex(document.as_slice(), entry.machine_blake3.as_str()) {
                    return Err(invalid(
                        path,
                        "packed shard machine document blake3 mismatch",
                    ));
                }
            }
            ("package_json", None) => {
                return Err(invalid(path, "packed shard missing machine document"));
            }
            (_, Some(_)) => {
                return Err(invalid(path, "packed shard unexpected machine document"));
            }
            (_, None) => {}
        }

        let package_json_read = entry.package_json_read.as_ref();
        match (kind, package_json_read) {
            ("package_json", Some(read)) => validate_package_json_read_payload_v4(path, read)?,
            ("package_json", None) => {}
            (_, Some(_)) => {
                return Err(invalid(
                    path,
                    "packed shard unexpected package-json read payload",
                ));
            }
            (_, None) => {}
        }

        identity_input.push_str(key);
        identity_input.push('\0');
        identity_input.push_str(entry.source_blake3.as_str());
        identity_input.push('\0');
        identity_input.push_str(entry.machine_blake3.as_str());
        identity_input.push('\0');
        if include_package_read_identity {
            match package_json_read {
                Some(read) => {
                    let identity = package_json_read_identity_v4(path, read)?;
                    identity_input.push_str(identity.to_hex().as_str());
                }
                None => identity_input.push_str("none"),
            }
            identity_input.push('\0');
        }
    }

    let kind = shard_kind.ok_or_else(|| invalid(path, "packed shard has no entry kind"))?;
    let Some(kind_id) = packed_shard_kind_id(kind) else {
        return Err(invalid(path, "packed shard kind is not canonical"));
    };
    if header.kind_id != kind_id {
        return Err(invalid(path, "packed shard kind id mismatch"));
    }
    if blake3::hash(identity_input.as_bytes()).as_bytes() != &header.source_identity_blake3 {
        return Err(invalid(path, "packed shard source identity mismatch"));
    }

    let mut machine_identity_input = String::with_capacity("machine:".len() + identity_input.len());
    machine_identity_input.push_str("machine:");
    machine_identity_input.push_str(&identity_input);
    if blake3::hash(machine_identity_input.as_bytes()).as_bytes() != &header.machine_identity_blake3
    {
        return Err(invalid(path, "packed shard machine identity mismatch"));
    }

    Ok(())
}

fn validate_packed_shard_with_package_read_v5(
    path: &Path,
    header: &DxJsMachineCachePackedShardHeader,
    shard: &ArchivedJsCacheShardMachineV5,
) -> Result<(), DxMachineCacheError> {
    if header.reserved.iter().any(|byte| *byte != 0) {
        return Err(invalid(path, "packed shard reserved bytes mismatch"));
    }

    let entries = &shard.entries;
    if header.entry_count as usize != entries.len() {
        return Err(invalid(path, "packed shard entry count mismatch"));
    }
    if entries.is_empty() {
        return Err(invalid(path, "packed shard has no entries"));
    }
    if !is_safe_repo_relative_path(shard.shard.as_str()) {
        return Err(invalid(path, "packed shard path is not repo-relative"));
    }
    let shard_path_identity = packed_shard_path_identity_input(shard.shard.as_str());
    if blake3::hash(shard_path_identity.as_bytes()).as_bytes() != &header.shard_path_blake3 {
        return Err(invalid(path, "packed shard path identity mismatch"));
    }

    let mut previous_key: Option<&str> = None;
    let mut shard_kind: Option<&str> = None;
    let mut identity_input = String::new();

    for entry in entries.iter() {
        let key = entry.key.as_str();
        if previous_key.is_some_and(|previous| previous >= key) {
            return Err(invalid(
                path,
                "packed shard entries are not sorted by unique key",
            ));
        }
        previous_key = Some(key);

        let Some((kind, source_from_key)) = split_cache_key(key) else {
            return Err(invalid(path, "packed shard entry key is not canonical"));
        };
        if !is_safe_cache_kind(kind) || !is_safe_repo_relative_path(source_from_key) {
            return Err(invalid(path, "packed shard entry key is not canonical"));
        }
        match shard_kind {
            Some(previous) if previous != kind => {
                return Err(invalid(path, "packed shard mixes entry kinds"));
            }
            None => shard_kind = Some(kind),
            _ => {}
        }

        validate_cache_key(path, key, kind, entry.source.as_str())?;
        if !is_safe_repo_relative_path(entry.source.as_str())
            || !is_safe_repo_relative_path(entry.machine.as_str())
            || !is_safe_repo_relative_path(entry.metadata.as_str())
        {
            return Err(invalid(
                path,
                "packed shard entry path is not repo-relative",
            ));
        }
        if entry
            .key_interning
            .as_ref()
            .is_some_and(|value| !is_safe_repo_relative_path(value.as_str()))
        {
            return Err(invalid(
                path,
                "packed shard key interning path is not repo-relative",
            ));
        }
        if !is_lower_hex_64(entry.source_blake3.as_str())
            || !is_lower_hex_64(entry.machine_blake3.as_str())
        {
            return Err(invalid(
                path,
                "packed shard entry blake3 is not lowercase hex",
            ));
        }

        match (kind, entry.machine_document.as_ref()) {
            ("package_json", Some(document)) => {
                if !blake3_matches_hex(document.as_slice(), entry.machine_blake3.as_str()) {
                    return Err(invalid(
                        path,
                        "packed shard machine document blake3 mismatch",
                    ));
                }
            }
            ("package_json", None) => {
                return Err(invalid(path, "packed shard missing machine document"));
            }
            (_, Some(_)) => {
                return Err(invalid(path, "packed shard unexpected machine document"));
            }
            (_, None) => {}
        }

        let package_json_read = entry.package_json_read.as_ref();
        match (kind, package_json_read) {
            ("package_json", Some(read)) => validate_package_json_read_payload(path, read)?,
            ("package_json", None) => {}
            (_, Some(_)) => {
                return Err(invalid(
                    path,
                    "packed shard unexpected package-json read payload",
                ));
            }
            (_, None) => {}
        }

        identity_input.push_str(key);
        identity_input.push('\0');
        identity_input.push_str(entry.source_blake3.as_str());
        identity_input.push('\0');
        identity_input.push_str(entry.machine_blake3.as_str());
        identity_input.push('\0');
        match package_json_read {
            Some(read) => {
                let identity = package_json_read_identity(path, read)?;
                identity_input.push_str(identity.to_hex().as_str());
            }
            None => identity_input.push_str("none"),
        }
        identity_input.push('\0');
    }

    let kind = shard_kind.ok_or_else(|| invalid(path, "packed shard has no entry kind"))?;
    let Some(kind_id) = packed_shard_kind_id(kind) else {
        return Err(invalid(path, "packed shard kind is not canonical"));
    };
    if header.kind_id != kind_id {
        return Err(invalid(path, "packed shard kind id mismatch"));
    }
    if blake3::hash(identity_input.as_bytes()).as_bytes() != &header.source_identity_blake3 {
        return Err(invalid(path, "packed shard source identity mismatch"));
    }

    let mut machine_identity_input = String::with_capacity("machine:".len() + identity_input.len());
    machine_identity_input.push_str("machine:");
    machine_identity_input.push_str(&identity_input);
    if blake3::hash(machine_identity_input.as_bytes()).as_bytes() != &header.machine_identity_blake3
    {
        return Err(invalid(path, "packed shard machine identity mismatch"));
    }

    Ok(())
}

fn package_json_read_identity_v4(
    path: &Path,
    read: &ArchivedPackageJsonReadMachineV4,
) -> Result<blake3::Hash, DxMachineCacheError> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"dx-package-json-read-v1");
    update_optional_archived_string_hash(&mut hasher, read.name.as_ref());
    update_optional_archived_string_hash(&mut hasher, read.version.as_ref());
    update_optional_archived_string_hash(&mut hasher, read.module_type.as_ref());
    update_optional_archived_index_hash(path, &mut hasher, read.exports.as_ref())?;
    update_optional_archived_index_hash(path, &mut hasher, read.imports.as_ref())?;
    update_u64_hash(&mut hasher, read.value_arena.len() as u64);
    for value in read.value_arena.iter() {
        update_package_json_read_value_hash(path, &mut hasher, value)?;
    }
    Ok(hasher.finalize())
}

fn package_json_read_identity(
    path: &Path,
    read: &ArchivedPackageJsonReadMachine,
) -> Result<blake3::Hash, DxMachineCacheError> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"dx-package-json-read-v2");
    update_optional_archived_string_hash(&mut hasher, read.name.as_ref());
    update_optional_archived_string_hash(&mut hasher, read.version.as_ref());
    update_optional_archived_string_hash(&mut hasher, read.module_type.as_ref());
    update_optional_archived_string_hash(&mut hasher, read.main.as_ref());
    update_optional_archived_string_hash(&mut hasher, read.module.as_ref());
    update_optional_archived_index_hash(path, &mut hasher, read.browser.as_ref())?;
    update_optional_archived_string_hash(&mut hasher, read.jsnext_main.as_ref());
    update_optional_archived_index_hash(path, &mut hasher, read.side_effects.as_ref())?;
    update_optional_archived_index_hash(path, &mut hasher, read.exports.as_ref())?;
    update_optional_archived_index_hash(path, &mut hasher, read.imports.as_ref())?;
    update_u64_hash(&mut hasher, read.value_arena.len() as u64);
    for value in read.value_arena.iter() {
        update_package_json_read_value_hash(path, &mut hasher, value)?;
    }
    Ok(hasher.finalize())
}

fn update_optional_archived_string_hash(
    hasher: &mut blake3::Hasher,
    value: Option<&rkyv::string::ArchivedString>,
) {
    match value {
        Some(value) => {
            hasher.update(&[1]);
            update_str_hash(hasher, value.as_str());
        }
        None => {
            hasher.update(&[0]);
        }
    };
}

fn update_optional_archived_index_hash<T>(
    path: &Path,
    hasher: &mut blake3::Hasher,
    value: Option<&T>,
) -> Result<(), DxMachineCacheError>
where
    T: Copy,
    usize: TryFrom<T>,
{
    match value {
        Some(value) => {
            hasher.update(&[1]);
            update_u64_hash(
                hasher,
                usize::try_from(*value)
                    .map_err(|_| invalid(path, "package-json read value index overflow"))?
                    as u64,
            );
        }
        None => {
            hasher.update(&[0]);
        }
    }
    Ok(())
}

fn update_package_json_read_value_hash(
    path: &Path,
    hasher: &mut blake3::Hasher,
    value: &ArchivedPackageJsonReadMachineValue,
) -> Result<(), DxMachineCacheError> {
    match value {
        ArchivedPackageJsonReadMachineValue::Str(value) => {
            hasher.update(&[b's']);
            update_str_hash(hasher, value.as_str());
        }
        ArchivedPackageJsonReadMachineValue::Bool(value) => {
            hasher.update(&[b'b', u8::from(*value)]);
        }
        ArchivedPackageJsonReadMachineValue::Null => {
            hasher.update(&[b'n']);
        }
        ArchivedPackageJsonReadMachineValue::Arr(items) => {
            hasher.update(&[b'a']);
            update_u64_hash(hasher, items.len() as u64);
            for index in items.iter() {
                update_u64_hash(
                    hasher,
                    usize::try_from(*index)
                        .map_err(|_| invalid(path, "package-json read value index overflow"))?
                        as u64,
                );
            }
        }
        ArchivedPackageJsonReadMachineValue::Obj(fields) => {
            hasher.update(&[b'o']);
            update_u64_hash(hasher, fields.len() as u64);
            for entry in fields.iter() {
                update_str_hash(hasher, entry.0.as_str());
                update_u64_hash(
                    hasher,
                    usize::try_from(entry.1)
                        .map_err(|_| invalid(path, "package-json read value index overflow"))?
                        as u64,
                );
            }
        }
    }
    Ok(())
}

fn update_str_hash(hasher: &mut blake3::Hasher, value: &str) {
    update_u64_hash(hasher, value.len() as u64);
    hasher.update(value.as_bytes());
}

fn update_u64_hash(hasher: &mut blake3::Hasher, value: u64) {
    hasher.update(&value.to_le_bytes());
}

fn validate_package_json_read_payload_v4(
    path: &Path,
    read: &ArchivedPackageJsonReadMachineV4,
) -> Result<(), DxMachineCacheError> {
    if let Some(index) = read.exports.as_ref() {
        validate_package_json_read_value_index_v4(
            path,
            read,
            usize::try_from(*index)
                .map_err(|_| invalid(path, "package-json read value index overflow"))?,
            0,
        )?;
    }
    if let Some(index) = read.imports.as_ref() {
        validate_package_json_read_value_index_v4(
            path,
            read,
            usize::try_from(*index)
                .map_err(|_| invalid(path, "package-json read value index overflow"))?,
            0,
        )?;
    }

    Ok(())
}

fn validate_package_json_read_payload(
    path: &Path,
    read: &ArchivedPackageJsonReadMachine,
) -> Result<(), DxMachineCacheError> {
    if let Some(index) = read.browser.as_ref() {
        validate_package_json_read_value_index(
            path,
            read,
            usize::try_from(*index)
                .map_err(|_| invalid(path, "package-json read value index overflow"))?,
            0,
        )?;
    }
    if let Some(index) = read.side_effects.as_ref() {
        validate_package_json_read_value_index(
            path,
            read,
            usize::try_from(*index)
                .map_err(|_| invalid(path, "package-json read value index overflow"))?,
            0,
        )?;
    }
    if let Some(index) = read.exports.as_ref() {
        validate_package_json_read_value_index(
            path,
            read,
            usize::try_from(*index)
                .map_err(|_| invalid(path, "package-json read value index overflow"))?,
            0,
        )?;
    }
    if let Some(index) = read.imports.as_ref() {
        validate_package_json_read_value_index(
            path,
            read,
            usize::try_from(*index)
                .map_err(|_| invalid(path, "package-json read value index overflow"))?,
            0,
        )?;
    }

    Ok(())
}

fn validate_package_json_read_value_index_v4(
    path: &Path,
    read: &ArchivedPackageJsonReadMachineV4,
    index: usize,
    depth: usize,
) -> Result<(), DxMachineCacheError> {
    if depth > 64 {
        return Err(invalid(path, "package-json read value depth overflow"));
    }

    match read.value_arena.get(index) {
        Some(ArchivedPackageJsonReadMachineValue::Str(_))
        | Some(ArchivedPackageJsonReadMachineValue::Bool(_))
        | Some(ArchivedPackageJsonReadMachineValue::Null) => Ok(()),
        Some(ArchivedPackageJsonReadMachineValue::Arr(items)) => {
            for index in items.iter() {
                validate_package_json_read_value_index_v4(
                    path,
                    read,
                    usize::try_from(*index)
                        .map_err(|_| invalid(path, "package-json read value index overflow"))?,
                    depth + 1,
                )?;
            }
            Ok(())
        }
        Some(ArchivedPackageJsonReadMachineValue::Obj(fields)) => {
            for entry in fields.iter() {
                validate_package_json_read_value_index_v4(
                    path,
                    read,
                    usize::try_from(entry.1)
                        .map_err(|_| invalid(path, "package-json read value index overflow"))?,
                    depth + 1,
                )?;
            }
            Ok(())
        }
        None => Err(invalid(path, "package-json read value index out of bounds")),
    }
}

fn validate_package_json_read_value_index(
    path: &Path,
    read: &ArchivedPackageJsonReadMachine,
    index: usize,
    depth: usize,
) -> Result<(), DxMachineCacheError> {
    if depth > 64 {
        return Err(invalid(path, "package-json read value depth overflow"));
    }

    match read.value_arena.get(index) {
        Some(ArchivedPackageJsonReadMachineValue::Str(_))
        | Some(ArchivedPackageJsonReadMachineValue::Bool(_))
        | Some(ArchivedPackageJsonReadMachineValue::Null) => Ok(()),
        Some(ArchivedPackageJsonReadMachineValue::Arr(items)) => {
            for index in items.iter() {
                validate_package_json_read_value_index(
                    path,
                    read,
                    usize::try_from(*index)
                        .map_err(|_| invalid(path, "package-json read value index overflow"))?,
                    depth + 1,
                )?;
            }
            Ok(())
        }
        Some(ArchivedPackageJsonReadMachineValue::Obj(fields)) => {
            for entry in fields.iter() {
                validate_package_json_read_value_index(
                    path,
                    read,
                    usize::try_from(entry.1)
                        .map_err(|_| invalid(path, "package-json read value index overflow"))?,
                    depth + 1,
                )?;
            }
            Ok(())
        }
        None => Err(invalid(path, "package-json read value index out of bounds")),
    }
}

fn packed_shard_path_identity_input(shard: &str) -> String {
    format!("{PACKED_SHARD_STORE_ROOT}/{shard}.dxjs")
}

fn validate_catalog_shard_entry(
    path: &Path,
    catalog_entry: &ArchivedJsCacheCatalogEntryMachine,
    shard_entry: &ArchivedJsCacheShardEntryMachine,
) -> Result<(), DxMachineCacheError> {
    if catalog_entry.key.as_str() != shard_entry.key.as_str()
        || catalog_entry.source.as_str() != shard_entry.source.as_str()
        || catalog_entry.machine.as_str() != shard_entry.machine.as_str()
        || catalog_entry.metadata.as_str() != shard_entry.metadata.as_str()
        || catalog_entry.source_blake3.as_str() != shard_entry.source_blake3.as_str()
        || catalog_entry.machine_blake3.as_str() != shard_entry.machine_blake3.as_str()
        || catalog_entry
            .key_interning
            .as_ref()
            .map(|value| value.as_str())
            != shard_entry
                .key_interning
                .as_ref()
                .map(|value| value.as_str())
    {
        return Err(invalid(path, "catalog shard entry mismatch"));
    }

    Ok(())
}

fn validate_catalog_shard_entry_v2(
    path: &Path,
    catalog_entry: &ArchivedJsCacheCatalogEntryMachine,
    shard_entry: &ArchivedJsCacheShardEntryMachineV2,
) -> Result<(), DxMachineCacheError> {
    if catalog_entry.key.as_str() != shard_entry.key.as_str()
        || catalog_entry.source.as_str() != shard_entry.source.as_str()
        || catalog_entry.machine.as_str() != shard_entry.machine.as_str()
        || catalog_entry.metadata.as_str() != shard_entry.metadata.as_str()
        || catalog_entry.source_blake3.as_str() != shard_entry.source_blake3.as_str()
        || catalog_entry.machine_blake3.as_str() != shard_entry.machine_blake3.as_str()
        || catalog_entry
            .key_interning
            .as_ref()
            .map(|value| value.as_str())
            != shard_entry
                .key_interning
                .as_ref()
                .map(|value| value.as_str())
    {
        return Err(invalid(path, "catalog shard entry mismatch"));
    }

    match (
        catalog_entry.kind.as_str(),
        shard_entry.machine_document.as_ref(),
    ) {
        ("package_json", Some(document)) => {
            if document.len() as u64 != catalog_entry.machine_bytes.to_native() {
                return Err(invalid(
                    path,
                    "catalog shard machine document byte mismatch",
                ));
            }
            if !blake3_matches_hex(document.as_slice(), catalog_entry.machine_blake3.as_str()) {
                return Err(invalid(
                    path,
                    "catalog shard machine document blake3 mismatch",
                ));
            }
        }
        ("package_json", None) => {
            return Err(invalid(path, "catalog shard missing machine document"));
        }
        (_, Some(_)) => {
            return Err(invalid(path, "catalog shard unexpected machine document"));
        }
        (_, None) => {}
    }

    Ok(())
}

fn validate_catalog_shard_entry_v3(
    path: &Path,
    catalog_entry: &ArchivedJsCacheCatalogEntryMachine,
    shard_entry: &ArchivedJsCacheShardEntryMachineV3,
) -> Result<(), DxMachineCacheError> {
    if catalog_entry.key.as_str() != shard_entry.key.as_str()
        || catalog_entry.source.as_str() != shard_entry.source.as_str()
        || catalog_entry.machine.as_str() != shard_entry.machine.as_str()
        || catalog_entry.metadata.as_str() != shard_entry.metadata.as_str()
        || catalog_entry.source_blake3.as_str() != shard_entry.source_blake3.as_str()
        || catalog_entry.machine_blake3.as_str() != shard_entry.machine_blake3.as_str()
        || catalog_entry
            .key_interning
            .as_ref()
            .map(|value| value.as_str())
            != shard_entry
                .key_interning
                .as_ref()
                .map(|value| value.as_str())
    {
        return Err(invalid(path, "catalog shard entry mismatch"));
    }

    match (
        catalog_entry.kind.as_str(),
        shard_entry.machine_document.as_ref(),
    ) {
        ("package_json", Some(document)) => {
            if document.len() as u64 != catalog_entry.machine_bytes.to_native() {
                return Err(invalid(
                    path,
                    "catalog shard machine document byte mismatch",
                ));
            }
            if !blake3_matches_hex(document.as_slice(), catalog_entry.machine_blake3.as_str()) {
                return Err(invalid(
                    path,
                    "catalog shard machine document blake3 mismatch",
                ));
            }
        }
        ("package_json", None) => {
            return Err(invalid(path, "catalog shard missing machine document"));
        }
        (_, Some(_)) => {
            return Err(invalid(path, "catalog shard unexpected machine document"));
        }
        (_, None) => {}
    }

    match (
        catalog_entry.kind.as_str(),
        shard_entry.package_json_read.as_ref(),
    ) {
        ("package_json", Some(read)) => validate_package_json_read_payload_v4(path, read)?,
        ("package_json", None) => {}
        (_, Some(_)) => {
            return Err(invalid(
                path,
                "catalog shard unexpected package-json read payload",
            ));
        }
        (_, None) => {}
    }

    Ok(())
}

fn validate_catalog_shard_entry_v5(
    path: &Path,
    catalog_entry: &ArchivedJsCacheCatalogEntryMachine,
    shard_entry: &ArchivedJsCacheShardEntryMachineV5,
) -> Result<(), DxMachineCacheError> {
    if catalog_entry.key.as_str() != shard_entry.key.as_str()
        || catalog_entry.source.as_str() != shard_entry.source.as_str()
        || catalog_entry.machine.as_str() != shard_entry.machine.as_str()
        || catalog_entry.metadata.as_str() != shard_entry.metadata.as_str()
        || catalog_entry.source_blake3.as_str() != shard_entry.source_blake3.as_str()
        || catalog_entry.machine_blake3.as_str() != shard_entry.machine_blake3.as_str()
        || catalog_entry
            .key_interning
            .as_ref()
            .map(|value| value.as_str())
            != shard_entry
                .key_interning
                .as_ref()
                .map(|value| value.as_str())
    {
        return Err(invalid(path, "catalog shard entry mismatch"));
    }

    match (
        catalog_entry.kind.as_str(),
        shard_entry.machine_document.as_ref(),
    ) {
        ("package_json", Some(document)) => {
            if document.len() as u64 != catalog_entry.machine_bytes.to_native() {
                return Err(invalid(
                    path,
                    "catalog shard machine document byte mismatch",
                ));
            }
            if !blake3_matches_hex(document.as_slice(), catalog_entry.machine_blake3.as_str()) {
                return Err(invalid(
                    path,
                    "catalog shard machine document blake3 mismatch",
                ));
            }
        }
        ("package_json", None) => {
            return Err(invalid(path, "catalog shard missing machine document"));
        }
        (_, Some(_)) => {
            return Err(invalid(path, "catalog shard unexpected machine document"));
        }
        (_, None) => {}
    }

    match (
        catalog_entry.kind.as_str(),
        shard_entry.package_json_read.as_ref(),
    ) {
        ("package_json", Some(read)) => validate_package_json_read_payload(path, read)?,
        ("package_json", None) => {}
        (_, Some(_)) => {
            return Err(invalid(
                path,
                "catalog shard unexpected package-json read payload",
            ));
        }
        (_, None) => {}
    }

    Ok(())
}

fn checked_add_u64(
    lhs: u64,
    rhs: u64,
    path: &Path,
    reason: &'static str,
) -> Result<u64, DxMachineCacheError> {
    lhs.checked_add(rhs).ok_or_else(|| invalid(path, reason))
}

fn validate_cache_key(
    path: &Path,
    key: &str,
    kind: &str,
    source: &str,
) -> Result<(), DxMachineCacheError> {
    let Some((key_kind, key_source)) = split_cache_key(key) else {
        return Err(invalid(path, "cache key is not canonical"));
    };
    if key_kind != kind || key_source != source {
        return Err(invalid(path, "cache key kind/source mismatch"));
    }
    Ok(())
}

fn cache_key(kind: &str, source: &str) -> String {
    let mut key = String::with_capacity(kind.len() + 1 + source.len());
    key.push_str(kind);
    key.push('\0');
    key.push_str(source);
    key
}

fn compare_lookup_key(lookup_key: &str, kind: &str, source: &str) -> std::cmp::Ordering {
    let lookup = lookup_key.as_bytes();
    let virtual_len = kind.len() + 1 + source.len();
    let compare_len = lookup.len().min(virtual_len);

    for (index, left) in lookup.iter().copied().take(compare_len).enumerate() {
        let right = virtual_cache_key_byte(kind.as_bytes(), source.as_bytes(), index);
        match left.cmp(&right) {
            std::cmp::Ordering::Equal => {}
            ordering => return ordering,
        }
    }

    lookup.len().cmp(&virtual_len)
}

#[inline]
fn virtual_cache_key_byte(kind: &[u8], source: &[u8], index: usize) -> u8 {
    if index < kind.len() {
        return kind[index];
    }
    if index == kind.len() {
        return 0;
    }
    source[index - kind.len() - 1]
}

fn split_cache_key(key: &str) -> Option<(&str, &str)> {
    let (kind, source) = key.split_once('\0')?;
    (!kind.is_empty() && !source.is_empty() && !source.contains('\0')).then_some((kind, source))
}

fn packed_shard_kind_id(kind: &str) -> Option<u32> {
    match kind {
        "package_json" => Some(1),
        "tsconfig" => Some(2),
        "bunfig" => Some(3),
        _ => None,
    }
}

fn is_safe_cache_kind(value: &str) -> bool {
    matches!(value, "package_json" | "tsconfig" | "bunfig")
}

fn is_safe_repo_relative_path(value: &str) -> bool {
    if value.is_empty()
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.starts_with("//")
        || value.starts_with("\\\\")
        || value.contains(':')
        || value.contains('\0')
    {
        return false;
    }

    let value = value.replace('\\', "/");
    if value.as_bytes().get(1).is_some_and(|byte| *byte == b':')
        && value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphabetic())
    {
        return false;
    }

    value
        .split('/')
        .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn is_lower_hex_64(value: &str) -> bool {
    is_lower_hex(value, 64)
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_lower_hex_prefix(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_u64_le(path: &Path, bytes: &[u8]) -> Result<u64, DxMachineCacheError> {
    let bytes: [u8; 8] = bytes
        .try_into()
        .map_err(|_| invalid(path, "machine envelope integer length mismatch"))?;
    Ok(u64::from_le_bytes(bytes))
}

fn usize_from_u64(value: u64, path: &Path) -> Result<usize, DxMachineCacheError> {
    usize::try_from(value).map_err(|_| invalid(path, "machine envelope length overflows usize"))
}

fn blake3_matches_hex(bytes: &[u8], expected_hex: &str) -> bool {
    blake3::hash(bytes).to_hex().as_str() == expected_hex
}

fn invalid(path: &Path, reason: &'static str) -> DxMachineCacheError {
    DxMachineCacheError::Invalid {
        path: path.display().to_string(),
        reason,
    }
}

#[inline]
pub fn shadow_probe_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        !machine_cache_disabled()
            && std::env::var_os(SHADOW_ENV)
                .as_deref()
                .is_some_and(shadow_env_truthy)
    })
}

#[inline]
pub fn read_through_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        !machine_cache_disabled()
            && std::env::var_os(READ_ENV)
                .as_deref()
                .is_some_and(shadow_env_truthy)
    })
}

#[inline]
pub fn machine_cache_disabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os(DISABLE_ENV)
            .as_deref()
            .is_some_and(shadow_env_truthy)
    })
}

#[inline]
pub fn integrated_read_enabled() -> bool {
    !machine_cache_disabled()
}

#[inline]
pub fn fast_read_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        !machine_cache_disabled()
            && std::env::var_os(FAST_READ_ENV)
                .as_deref()
                .is_some_and(shadow_env_truthy)
    })
}

#[inline]
pub fn package_json_path_read_enabled() -> bool {
    integrated_read_enabled() || fast_read_enabled()
}

#[inline]
pub fn trust_document_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os(TRUST_DOCUMENT_ENV)
            .as_deref()
            .is_some_and(shadow_env_truthy)
    })
}

#[inline]
pub fn trust_source_metadata_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os(TRUST_SOURCE_METADATA_ENV)
            .as_deref()
            .is_some_and(shadow_env_truthy)
    })
}

#[inline]
pub fn trust_package_json_read_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os(TRUST_PACKAGE_JSON_READ_ENV)
            .as_deref()
            .is_some_and(shadow_env_truthy)
    })
}

#[inline]
fn trust_package_json_snapshot_enabled() -> bool {
    trust_source_metadata_enabled() && trust_package_json_read_enabled()
}

#[inline]
fn trusted_package_json_snapshot_for_root(root: &Path) -> bool {
    trust_package_json_snapshot_enabled() || root_has_trusted_package_json_snapshot(root)
}

fn root_has_trusted_package_json_snapshot(root: &Path) -> bool {
    let mut store = process_cache()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    if let Some(trusted) = store.trusted_package_json_snapshots.get(root) {
        return *trusted;
    }

    let trusted = root_has_trusted_package_json_snapshot_uncached(root);
    store
        .trusted_package_json_snapshots
        .insert(root.to_path_buf(), trusted);
    trusted
}

fn root_has_trusted_package_json_snapshot_uncached(root: &Path) -> bool {
    root.join(".dx")
        .join("js")
        .join(TRUSTED_PACKAGE_JSON_SNAPSHOT_MARKER)
        .is_file()
}

#[inline]
pub fn buffer_documents_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os(BUFFER_DOCUMENTS_ENV)
            .as_deref()
            .is_some_and(shadow_env_truthy)
    })
}

#[inline]
pub fn packed_document_read_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os(PACKED_DOCUMENT_READ_ENV)
            .as_deref()
            .is_some_and(shadow_env_truthy)
    })
}

#[inline]
pub fn packed_package_json_read_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        !machine_cache_disabled()
            && (integrated_read_enabled()
                || std::env::var_os(PACKED_PACKAGE_JSON_READ_ENV)
                    .as_deref()
                    .is_some_and(shadow_env_truthy))
    })
}

#[inline]
fn machine_document_integrity() -> MachineDocumentIntegrity {
    if trust_document_enabled() {
        MachineDocumentIntegrity::EnvelopePayload
    } else {
        MachineDocumentIntegrity::FullFileHash
    }
}

fn shadow_env_truthy(value: &std::ffi::OsStr) -> bool {
    let Some(text) = value.to_str() else {
        return false;
    };
    let text = text.trim().to_ascii_lowercase();
    let text = text.as_str();
    matches!(text, "1" | "true" | "yes" | "on")
}

fn path_from_utf8_bytes(path: &[u8]) -> Option<&Path> {
    let text = std::str::from_utf8(path).ok()?;
    (!text.is_empty()).then(|| Path::new(text))
}

fn find_machine_cache_root(source_path: &Path) -> Option<PathBuf> {
    if let Some(root) = explicit_machine_cache_root(source_path) {
        return Some(root.to_path_buf());
    }

    {
        let store = process_cache()
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(root) = store.last_root.as_ref()
            && source_path.starts_with(root)
        {
            return Some(root.clone());
        }
    }

    let anchor = machine_cache_root_search_anchor(source_path.parent()?);
    {
        let store = process_cache()
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(root) = store.roots.get(&anchor) {
            return root.clone();
        }
    }

    let root = find_machine_cache_root_uncached(&anchor);
    let mut store = process_cache()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    store.roots.insert(anchor, root.clone());
    if let Some(root) = root.as_ref() {
        store.last_root = Some(root.clone());
    }
    root
}

fn machine_cache_root_search_anchor(start: &Path) -> PathBuf {
    let mut dir = start;
    while path_contains_node_modules_component(dir) {
        let Some(parent) = dir.parent() else {
            break;
        };
        dir = parent;
    }
    dir.to_path_buf()
}

fn find_machine_cache_root_uncached(mut dir: &Path) -> Option<PathBuf> {
    loop {
        if !path_contains_node_modules_component(dir)
            && dir.join(".dx").join("js").join("catalog.machine").is_file()
        {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

fn explicit_machine_cache_root(source_path: &Path) -> Option<&'static PathBuf> {
    let root = configured_machine_cache_root()?;
    source_path.starts_with(root).then_some(root)
}

fn configured_machine_cache_root() -> Option<&'static PathBuf> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        let value = std::env::var_os(CACHE_ROOT_ENV)?;
        let root = PathBuf::from(value);
        if root.as_os_str().is_empty()
            || !root.is_absolute()
            || path_contains_node_modules_component(&root)
            || !root
                .join(".dx")
                .join("js")
                .join("catalog.machine")
                .is_file()
        {
            return None;
        }

        Some(root)
    })
    .as_ref()
}

fn path_contains_node_modules_component(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            Component::Normal(name) if name.eq_ignore_ascii_case("node_modules")
        )
    })
}

fn repo_relative_source(root: &Path, source_path: &Path) -> Option<String> {
    let relative = source_path.strip_prefix(root).ok()?;
    let mut source = String::with_capacity(relative.as_os_str().len());

    for component in relative.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        if !source.is_empty() {
            source.push('/');
        }
        source.push_str(part.to_str()?);
    }

    (!source.is_empty()).then_some(source)
}
