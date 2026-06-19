use bun_collections::StringHashMap;

use crate::IndexStringMap::IndexInt;

/// Abstracts over the two structurally-identical `Path` ports (`bun_paths::fs::Path`
/// and `bun_resolver::fs::Path`) so the bundler can key the map with either while
/// the crates converge. Both expose `.text: &[u8]`, which is all we need.
pub trait PathLike {
    fn path_text(&self) -> &[u8];
}

// `bun_resolver::fs::Path` is now a re-export of `bun_paths::fs::Path` (D090),
// so a single impl covers both.
impl PathLike for bun_paths::fs::Path<'_> {
    #[inline]
    fn path_text(&self) -> &[u8] {
        self.text
    }
}

/// Bundler path-to-source index table.
///
/// The default APIs own key bytes. Use the explicit borrowed APIs only for
/// keys whose storage is proven to outlive the map.
#[derive(Default)]
pub struct PathToSourceIndexMap {
    pub map: Map,
}

pub type Map = StringHashMap<IndexInt>;

/// Mirrors Zig's `Map.GetOrPutResult` — std `HashMap::entry` doesn't expose
/// `found_existing` + value-ptr together, so we hand-roll a thin shim.
pub(crate) type GetOrPutResult<'a> = bun_collections::string_hash_map::GetOrPutResult<'a, IndexInt>;

impl PathToSourceIndexMap {
    pub fn get_path(&self, path: &impl PathLike) -> Option<IndexInt> {
        self.get(path.path_text())
    }

    pub fn get(&self, text: impl AsRef<[u8]>) -> Option<IndexInt> {
        self.map.get(text.as_ref()).copied()
    }

    pub fn put_path(
        &mut self,
        path: &impl PathLike,
        value: IndexInt,
    ) -> Result<(), bun_alloc::AllocError> {
        self.put(path.path_text(), value)
    }

    // Takes `&[u8]` (not `impl AsRef<[u8]>`) to mirror Zig's `text: []const u8`
    // and to avoid E0283 inference ambiguity at `.into()` call sites in bundle_v2.
    pub fn put(&mut self, text: &[u8], value: IndexInt) -> Result<(), bun_alloc::AllocError> {
        self.map.put(text, value)
    }

    /// Insert without copying `text`.
    ///
    /// # Safety
    /// The bytes behind `text` must remain alive and unmoved until the entry is
    /// removed or the map is dropped.
    pub unsafe fn put_borrowed(
        &mut self,
        text: &[u8],
        value: IndexInt,
    ) -> Result<(), bun_alloc::AllocError> {
        unsafe { self.map.put_borrowed(text, value) }
    }

    pub fn get_or_put_path(
        &mut self,
        path: &impl PathLike,
    ) -> Result<GetOrPutResult<'_>, bun_alloc::AllocError> {
        self.get_or_put(path.path_text())
    }

    pub fn get_or_put(
        &mut self,
        text: impl AsRef<[u8]>,
    ) -> Result<GetOrPutResult<'_>, bun_alloc::AllocError> {
        self.map.get_or_put(text.as_ref())
    }

    /// Get or insert a default value without copying `text`.
    ///
    /// # Safety
    /// The bytes behind `text` must remain alive and unmoved until the entry is
    /// removed or the map is dropped.
    pub unsafe fn get_or_put_borrowed(
        &mut self,
        text: impl AsRef<[u8]>,
    ) -> Result<GetOrPutResult<'_>, bun_alloc::AllocError> {
        Ok(unsafe { self.map.get_or_put_borrowed(text.as_ref()) })
    }

    pub fn remove(&mut self, text: impl AsRef<[u8]>) -> bool {
        self.map.remove(text.as_ref()).is_some()
    }

    pub fn remove_path(&mut self, path: &impl PathLike) -> bool {
        self.remove(path.path_text())
    }
}

// ported from: src/bundler/PathToSourceIndexMap.zig
