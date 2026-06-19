//! This pool exists because on Windows, each path buffer costs 64 KB.
//! This makes the stack memory usage very unpredictable, which means we can't
//! really know how much stack space we have left. This pool is a workaround to
//! make the stack memory usage more predictable. We keep up to 4 path buffers
//! alive per thread at a time.
//!
//! PORT NOTE: Zig used `bun.ObjectPool<T, null, true, 4>` (a thread-safe
//! 4-slot freelist). Rewritten over `thread_local!` + fixed inline slots per
//! PORTING.md §Concurrency (init-once / per-thread → no lock needed).
//! Same observable behavior: at most 4 buffers cached per thread; excess `put`s
//! drop. RAII guard replaces the manual `get`/`put` pairing.

use core::cell::RefCell;
use core::marker::PhantomData;
use core::ops::{Deref, DerefMut};

use crate::{PathBuffer, WPathBuffer};

const POOL_CAP: usize = 4;

#[doc(hidden)]
pub struct PoolSlots<T> {
    slots: [Option<Box<T>>; POOL_CAP],
    len: usize,
}

impl<T> PoolSlots<T> {
    const fn new() -> Self {
        Self {
            slots: [const { None }; POOL_CAP],
            len: 0,
        }
    }

    #[inline]
    fn pop(&mut self) -> Option<Box<T>> {
        if self.len == 0 {
            return None;
        }

        self.len -= 1;
        self.slots[self.len].take()
    }

    #[inline]
    fn push(&mut self, buf: Box<T>) {
        if self.len < POOL_CAP {
            self.slots[self.len] = Some(buf);
            self.len += 1;
        }
    }

    #[cfg(test)]
    #[inline]
    fn len(&self) -> usize {
        self.len
    }

    #[cfg(test)]
    #[inline]
    fn clear(&mut self) {
        while self.pop().is_some() {}
    }
}

/// Per-thread pool of reusable path buffers.
pub struct PathBufferPoolT<T: 'static + Default>(PhantomData<T>);

// One fixed-capacity thread-local pool per buffer type. Zig's threadsafe pool
// used a global lock; per-thread is closer to "use a thread-local allocator so
// mimalloc deletes it on thread deinit" (the original comment) and avoids any
// lock.
thread_local! {
    static U8_POOL: RefCell<PoolSlots<PathBuffer>> = const { RefCell::new(PoolSlots::new()) };
    static U16_POOL: RefCell<PoolSlots<WPathBuffer>> = const { RefCell::new(PoolSlots::new()) };
}

pub trait PoolStorage: Sized + Default + 'static {
    fn with_pool<R>(f: impl FnOnce(&RefCell<PoolSlots<Self>>) -> R) -> R;
    /// Allocate a fresh boxed buffer. Implemented per concrete type so the
    /// `assume_init` SAFETY obligation is discharged monomorphically (the
    /// generic site cannot soundly assert "every bit-pattern is valid" for an
    /// arbitrary `T`).
    fn new_boxed() -> Box<Self>;
}
impl PoolStorage for PathBuffer {
    fn with_pool<R>(f: impl FnOnce(&RefCell<PoolSlots<Self>>) -> R) -> R {
        U8_POOL.with(f)
    }
    #[inline]
    fn new_boxed() -> Box<Self> {
        // SAFETY: `PathBuffer` is `#[repr(transparent)]` over `[u8; N]`;
        // `new_zeroed` writes every byte to `0`, which is a valid `u8`, so the
        // value is fully initialized before `assume_init`. We use `new_zeroed`
        // rather than `new_uninit` because materializing a `Box<T>` whose bytes
        // were never written is UB even for integer arrays. This path runs only
        // on pool cache miss (≤ once per slot per thread); `alloc_zeroed` for a
        // 64 KB heap block is typically satisfied by fresh OS-zeroed pages, so
        // there is no hot-path memset cost.
        unsafe { Box::<Self>::new_zeroed().assume_init() }
    }
}
impl PoolStorage for WPathBuffer {
    fn with_pool<R>(f: impl FnOnce(&RefCell<PoolSlots<Self>>) -> R) -> R {
        U16_POOL.with(f)
    }
    #[inline]
    fn new_boxed() -> Box<Self> {
        // SAFETY: `WPathBuffer` is `#[repr(transparent)]` over `[u16; N]`;
        // `new_zeroed` writes every byte to `0`, which is a valid `u16`, so the
        // value is fully initialized before `assume_init`. See `PathBuffer`
        // impl above for rationale re: `new_uninit` UB and perf.
        unsafe { Box::<Self>::new_zeroed().assume_init() }
    }
}

impl<T: PoolStorage> PathBufferPoolT<T> {
    /// Returns an RAII guard that derefs to `&mut T` and returns the buffer to
    /// the pool on `Drop`. Replaces manual `get`/`put` pairing.
    pub fn get() -> PoolGuard<T> {
        // Zig leaves the buffer `undefined`; we zero-allocate on the (rare)
        // cache-miss path instead — see `PoolStorage::new_boxed` for the
        // soundness/perf justification.
        let buf = T::with_pool(|p| p.borrow_mut().pop()).unwrap_or_else(T::new_boxed);
        PoolGuard { buf: Some(buf) }
    }

    /// Manual return path (kept for structure parity with Zig). Prefer dropping
    /// the `PoolGuard` instead.
    pub(crate) fn put(buf: Box<T>) {
        T::with_pool(|p| {
            let mut p = p.borrow_mut();
            p.push(buf);
        });
    }
}

/// RAII guard returned by `PathBufferPoolT::get()`.
pub struct PoolGuard<T: PoolStorage> {
    buf: Option<Box<T>>,
}

impl<T: PoolStorage> Deref for PoolGuard<T> {
    type Target = T;
    #[inline]
    fn deref(&self) -> &T {
        self.buf
            .as_deref()
            .expect("path buffer guard still owns its buffer")
    }
}

impl<T: PoolStorage> DerefMut for PoolGuard<T> {
    #[inline]
    fn deref_mut(&mut self) -> &mut T {
        self.buf
            .as_deref_mut()
            .expect("path buffer guard still owns its buffer")
    }
}

impl<T: PoolStorage> Drop for PoolGuard<T> {
    fn drop(&mut self) {
        if let Some(buf) = self.buf.take() {
            PathBufferPoolT::<T>::put(buf);
        }
    }
}

#[allow(non_camel_case_types)]
pub type path_buffer_pool = PathBufferPoolT<PathBuffer>;
#[allow(non_camel_case_types)]
pub type w_path_buffer_pool = PathBufferPoolT<WPathBuffer>;

/// `bun.path_buffer_pool.get()` — convenience wrapper returning the RAII guard.
/// `Path<U>` callers store this in a `ManuallyDrop` and explicitly `put` on
/// reset (matches Zig's manual get/put), so also expose `into_box`/free `put`.
pub type Guard = PoolGuard<PathBuffer>;
#[inline]
pub fn get() -> PoolGuard<PathBuffer> {
    PathBufferPoolT::<PathBuffer>::get()
}
#[inline]
pub fn put(buf: Box<PathBuffer>) {
    PathBufferPoolT::<PathBuffer>::put(buf)
}

#[cfg(test)]
fn pool_len_for_tests<T: PoolStorage>() -> usize {
    T::with_pool(|p| p.borrow().len())
}

#[cfg(test)]
fn clear_pool_for_tests<T: PoolStorage>() {
    T::with_pool(|p| p.borrow_mut().clear());
}

impl<T: PoolStorage> PoolGuard<T> {
    /// Extract the `Box` without returning it to the pool (for `ManuallyDrop`
    /// owners that will `put` explicitly later). `Drop` is a no-op once `buf`
    /// is `None`, so no leak.
    #[inline]
    pub fn into_box(mut self) -> Box<T> {
        self.buf.take().unwrap()
    }
}

#[cfg(windows)]
#[allow(non_camel_case_types)]
pub type os_path_buffer_pool = w_path_buffer_pool;
#[cfg(not(windows))]
#[allow(non_camel_case_types)]
pub type os_path_buffer_pool = path_buffer_pool;

// ported from: src/paths/path_buffer_pool.zig

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PathBuffer, WPathBuffer};

    #[test]
    fn dropped_guard_returns_path_buffer_to_current_thread_pool() {
        clear_pool_for_tests::<PathBuffer>();
        assert_eq!(pool_len_for_tests::<PathBuffer>(), 0);

        {
            let _guard = PathBufferPoolT::<PathBuffer>::get();
            assert_eq!(pool_len_for_tests::<PathBuffer>(), 0);
        }

        assert_eq!(pool_len_for_tests::<PathBuffer>(), 1);
        clear_pool_for_tests::<PathBuffer>();
    }

    #[test]
    fn path_buffer_pool_keeps_only_four_buffers_per_thread() {
        clear_pool_for_tests::<PathBuffer>();

        let guards: Vec<_> = (0..POOL_CAP + 1)
            .map(|_| PathBufferPoolT::<PathBuffer>::get())
            .collect();
        assert_eq!(pool_len_for_tests::<PathBuffer>(), 0);

        drop(guards);

        assert_eq!(pool_len_for_tests::<PathBuffer>(), POOL_CAP);
        clear_pool_for_tests::<PathBuffer>();
    }

    #[test]
    fn wide_path_buffer_pool_keeps_only_four_buffers_per_thread() {
        clear_pool_for_tests::<WPathBuffer>();

        let guards: Vec<_> = (0..POOL_CAP + 1)
            .map(|_| PathBufferPoolT::<WPathBuffer>::get())
            .collect();
        assert_eq!(pool_len_for_tests::<WPathBuffer>(), 0);

        drop(guards);

        assert_eq!(pool_len_for_tests::<WPathBuffer>(), POOL_CAP);
        clear_pool_for_tests::<WPathBuffer>();
    }
}
