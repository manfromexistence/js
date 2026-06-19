import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("keeps bundler path-to-source index map safe by default with explicit borrowed fast path", () => {
  const mapSource = readFileSync(new URL("../src/bundler/PathToSourceIndexMap.rs", import.meta.url), "utf8");
  const bundleSource = readFileSync(new URL("../src/bundler/bundle_v2.rs", import.meta.url), "utf8");

  expect(mapSource).toContain("pub type Map = StringHashMap<IndexInt>;");
  expect(mapSource).toContain("pub fn put(&mut self, text: &[u8], value: IndexInt)");
  expect(mapSource).toContain("self.map.put(text, value)");
  expect(mapSource).toContain("self.map.get_or_put(text.as_ref())");
  expect(mapSource).toContain("pub unsafe fn put_borrowed");
  expect(mapSource).toContain("pub unsafe fn get_or_put_borrowed");
  expect(mapSource).toContain("Use the explicit borrowed APIs only");
  expect(mapSource).not.toContain("dupe here");
  expect(mapSource).not.toContain("StringHashMap gains a borrowed-key variant");
  expect(bundleSource).not.toContain("PathToSourceIndexMap` borrows path keys");
  expect(bundleSource).not.toContain("duped the key into the map");
});
