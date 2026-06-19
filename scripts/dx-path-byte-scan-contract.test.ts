import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stringPathsSource = readFileSync(new URL("../src/paths/string_paths.rs", import.meta.url), "utf8");

test("path node_modules detection uses memmem with segment-boundary semantics", () => {
  expect(stringPathsSource).toContain("pub fn path_contains_node_modules_folder(path: &[u8]) -> bool");
  expect(stringPathsSource).toContain("memchr::memmem::find(path, crate::NODE_MODULES_NEEDLE).is_some()");
  expect(stringPathsSource).not.toContain("strings::contains(path, comptime std.fs.path.sep_str ++ \"node_modules\"");

  expect(pathContainsNodeModulesFolder("/repo/node_modules/pkg/index.js", "/")).toBe(true);
  expect(pathContainsNodeModulesFolder("C:\\repo\\node_modules\\pkg\\index.js", "\\")).toBe(true);
  expect(pathContainsNodeModulesFolder("node_modules", "/")).toBe(false);
  expect(pathContainsNodeModulesFolder("/repo/node_modules", "/")).toBe(false);
  expect(pathContainsNodeModulesFolder("/repo/not_node_modules/pkg", "/")).toBe(false);
});

function pathContainsNodeModulesFolder(path: string, separator: "/" | "\\"): boolean {
  return path.includes(`${separator}node_modules${separator}`);
}
