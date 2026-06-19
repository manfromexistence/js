import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, ...relativePath.split("/")), "utf8");
}

test("keeps internal sourcemap find-cache wiring on the stack remap path", () => {
  const internalSourceMap = readRepoFile("src/sourcemap/InternalSourceMap.zig");
  const savedSourceMap = readRepoFile("src/jsc/SavedSourceMap.zig");
  const virtualMachine = readRepoFile("src/jsc/VirtualMachine.zig");
  const savedSourceMapRust = readRepoFile("src/jsc/SavedSourceMap.rs");

  expect(internalSourceMap).toContain("pub const FindCache");
  expect(internalSourceMap).toContain("pub fn findWithCache");
  expect(savedSourceMap).toContain("find_cache: InternalSourceMap.FindCache");
  expect(savedSourceMap).toContain("this.find_cache.invalidateAll()");
  expect(virtualMachine).toContain("pub fn remapStackFramePositions");
  expect(virtualMachine).toContain("ism.findWithCache(frame.position.line, frame.position.column, &sm.find_cache)");
  expect(savedSourceMapRust).toContain("use bun_collections::{HashMap, IdentityContext, TaggedPtrUnion};");
  expect(savedSourceMapRust).toContain("pub type HashTable = HashMap<u64, *mut c_void, IdentityContext<u64>>;");
  expect(savedSourceMapRust).toContain("pub find_cache: FindCache");
  expect(savedSourceMapRust).toContain("fn invalidate_internal_source_map(&mut self, ism: InternalSourceMap)");
  expect(savedSourceMapRust).toContain("self.find_cache.invalidate(ism.data);");
  expect(savedSourceMapRust).toContain("self.clear_last_ism_for_key(key);");
  expect(savedSourceMapRust).toContain("pub fn find_mapping_with_cache(");
  expect(savedSourceMapRust).toContain("return ism.find_with_cache(line, column, &mut self.find_cache);");
});

test("routes sourcemap table replacements and removals through targeted cache invalidation", () => {
  const savedSourceMapRust = readRepoFile("src/jsc/SavedSourceMap.rs");

  const releaseTableValue = savedSourceMapRust.indexOf("fn release_table_value(&mut self, key: u64, value: Value)");
  const removeValueIfLocked = savedSourceMapRust.indexOf("fn remove_value_if_locked(");
  const putValue = savedSourceMapRust.indexOf("pub fn put_value(&mut self, path: &[u8], value: Value)");
  expect(releaseTableValue).toBeGreaterThan(0);
  expect(removeValueIfLocked).toBeGreaterThan(releaseTableValue);
  expect(putValue).toBeGreaterThan(removeValueIfLocked);

  const releaseBody = savedSourceMapRust.slice(releaseTableValue, removeValueIfLocked);
  expect(releaseBody).toContain("self.clear_last_ism_for_key(key);");
  expect(releaseBody).toContain("self.invalidate_internal_source_map(ism);");
  expect(releaseBody).toContain("ism.free_owned();");

  const removeBody = savedSourceMapRust.slice(removeValueIfLocked, putValue);
  expect(removeBody).toContain("map.remove(&key);");
  expect(removeBody).toContain("self.release_table_value(key, removed_value);");

  const putBody = savedSourceMapRust.slice(putValue, savedSourceMapRust.indexOf("fn get_with_content(", putValue));
  expect(putBody).toContain(".insert(key, value.ptr())");
  expect(putBody).toContain("self.release_table_value(key, old_value);");
  expect(putBody).toContain("self.clear_last_ism_for_key(key);");
});

test("keeps internal sourcemaps deferred until JSON VLQ output is requested", () => {
  const chunk = readRepoFile("src/sourcemap/Chunk.zig");

  expect(chunk).toContain("printSourceMapContentsFromInternal");
  expect(chunk).toContain("ism.appendVLQTo(&vlq)");
});
