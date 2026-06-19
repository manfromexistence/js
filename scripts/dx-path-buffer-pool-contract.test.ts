import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("path buffer pool stays a fixed-slot thread-local RAII pool", () => {
  const pool = readRepoFile("src/paths/path_buffer_pool.rs");
  const path = readRepoFile("src/paths/Path.rs");
  const stringPaths = readRepoFile("src/paths/string_paths.rs");
  const resolvePath = readRepoFile("src/paths/resolve_path.rs");
  const packageManager = readRepoFile("src/install/PackageManager.rs");
  const plan = readRepoFile("PLAN.md");

  expect(pool).toContain("const POOL_CAP: usize = 4;");
  expect(pool).toContain("slots: [Option<Box<T>>; POOL_CAP]");
  expect(pool).not.toContain("SmallVec");
  expect(pool).not.toContain("Vec<Box<T>>");
  expect(pool).toContain("thread_local!");
  expect(pool).toContain("static U8_POOL: RefCell<PoolSlots<PathBuffer>>");
  expect(pool).toContain("static U16_POOL: RefCell<PoolSlots<WPathBuffer>>");
  expect(pool).toContain("pub struct PoolGuard<T: PoolStorage>");
  expect(pool).toContain("impl<T: PoolStorage> Drop for PoolGuard<T>");
  expect(pool).toContain("PathBufferPoolT::<T>::put(buf);");
  expect(pool).toContain("dropped_guard_returns_path_buffer_to_current_thread_pool");
  expect(pool).toContain("path_buffer_pool_keeps_only_four_buffers_per_thread");
  expect(pool).toContain("wide_path_buffer_pool_keeps_only_four_buffers_per_thread");

  expect(path).toContain("crate::path_buffer_pool::get()");
  expect(path).toContain("crate::w_path_buffer_pool::get()");
  expect(stringPaths).toContain("crate::path_buffer_pool::get()");
  expect(resolvePath).toContain("JoinScratch::Pooled(crate::path_buffer_pool::get())");
  expect(packageManager).toContain("PathBuffer::uninit()");
  expect(plan).toContain("| 25 | Source-side/proven |");
  expect(plan).toContain("not actually a `SmallVec` pool");
  expect(plan).toContain("Many path-heavy call sites still do not use the pool.");
});
