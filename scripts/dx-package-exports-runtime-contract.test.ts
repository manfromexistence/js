import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const localBun = join(repoRoot, "build", "release", "bun.exe");
const fixtureRoot = join(repoRoot, ".tmp", "dx-package-exports-runtime-contract");

test("local release resolves package exports/imports exact keys before wildcard expansions", () => {
  expect(existsSync(localBun)).toBe(true);
  const threshold = exactKeyIndexThreshold();
  const exactEntryCount = threshold + 8;
  const exactExportIndex = exactEntryCount - 3;
  const exactImportIndex = exactEntryCount - 5;
  resetFixture();

  const imports: Record<string, unknown> = {
    "#internal": {
      bun: "./internal-exact.ts",
      default: "./internal-default.ts",
    },
    "#util/*": {
      bun: "./util/*.ts",
      default: "./bad/*.ts",
    },
    "#util/special/*": {
      bun: "./util-special/*.ts",
      default: "./bad/*.ts",
    },
    "#util/*/deep": {
      bun: "./util-deep/*.ts",
      default: "./bad/*.ts",
    },
  };
  for (let index = 0; index < exactEntryCount; index++) {
    imports[`#exact/${index}`] = {
      bun: `./exact-imports/${index}.ts`,
      default: "./bad/internal-default.ts",
    };
  }

  writeJson(join(fixtureRoot, "package.json"), {
    type: "module",
    imports,
  });

  writeFileSync(join(fixtureRoot, "entry.ts"), [
    'import root from "@dx/exact";',
    'import exact from "@dx/exact/feature/a";',
    `import manyExact from "@dx/exact/exact/${exactExportIndex}";`,
    'import wildcard from "@dx/exact/feature/b";',
    'import specialWildcard from "@dx/exact/feature/special/tool";',
    'import deepWildcard from "@dx/exact/feature/group/deep";',
    'import internal from "#internal";',
    `import manyInternal from "#exact/${exactImportIndex}";`,
    'import util from "#util/tool";',
    'import specialUtil from "#util/special/tool";',
    'import deepUtil from "#util/group/deep";',
    [
      "console.log(JSON.stringify({",
      "  root, exact, manyExact, wildcard, specialWildcard, deepWildcard,",
      "  internal, manyInternal, util, specialUtil, deepUtil,",
      "}));",
    ].join("\n"),
    "",
  ].join("\n"));
  writeFileSync(join(fixtureRoot, "internal-exact.ts"), 'export default "internal-exact";\n');
  writeFileSync(join(fixtureRoot, "internal-default.ts"), 'export default "wrong-internal-default";\n');
  mkdirSync(join(fixtureRoot, "exact-imports"), { recursive: true });
  for (let index = 0; index < exactEntryCount; index++) {
    writeFileSync(join(fixtureRoot, "exact-imports", `${index}.ts`), `export default "import-exact-${index}";\n`);
  }
  mkdirSync(join(fixtureRoot, "util"), { recursive: true });
  mkdirSync(join(fixtureRoot, "util", "special"), { recursive: true });
  mkdirSync(join(fixtureRoot, "util", "group"), { recursive: true });
  mkdirSync(join(fixtureRoot, "util-special"), { recursive: true });
  mkdirSync(join(fixtureRoot, "util-deep"), { recursive: true });
  mkdirSync(join(fixtureRoot, "bad"), { recursive: true });
  writeFileSync(join(fixtureRoot, "util", "tool.ts"), 'export default "util-wildcard";\n');
  writeFileSync(join(fixtureRoot, "util", "special", "tool.ts"), 'export default "wrong-general-util-special";\n');
  writeFileSync(join(fixtureRoot, "util", "group", "deep.ts"), 'export default "wrong-general-util-deep";\n');
  writeFileSync(join(fixtureRoot, "util-special", "tool.ts"), 'export default "util-special-wildcard";\n');
  writeFileSync(join(fixtureRoot, "util-deep", "group.ts"), 'export default "util-deep-wildcard";\n');
  writeFileSync(join(fixtureRoot, "bad", "tool.ts"), 'export default "wrong-util-default";\n');

  const exports: Record<string, unknown> = {
    ".": {
      bun: "./root-bun.ts",
      default: "./root-default.ts",
    },
    "./feature/a": {
      bun: "./exact-a.ts",
      default: "./bad.ts",
    },
    "./feature/*": {
      bun: "./features/*.ts",
      default: "./bad/*.ts",
    },
    "./feature/special/*": {
      bun: "./features-special/*.ts",
      default: "./bad/*.ts",
    },
    "./feature/*/deep": {
      bun: "./features-deep/*.ts",
      default: "./bad/*.ts",
    },
  };
  for (let index = 0; index < exactEntryCount; index++) {
    exports[`./exact/${index}`] = {
      bun: `./exact/${index}.ts`,
      default: "./bad.ts",
    };
  }

  const packageRoot = join(fixtureRoot, "node_modules", "@dx", "exact");
  mkdirSync(join(packageRoot, "features"), { recursive: true });
  mkdirSync(join(packageRoot, "features", "special"), { recursive: true });
  mkdirSync(join(packageRoot, "features", "group"), { recursive: true });
  mkdirSync(join(packageRoot, "features-special"), { recursive: true });
  mkdirSync(join(packageRoot, "features-deep"), { recursive: true });
  mkdirSync(join(packageRoot, "exact"), { recursive: true });
  writeJson(join(packageRoot, "package.json"), {
    name: "@dx/exact",
    version: "1.0.0",
    type: "module",
    exports,
  });
  writeFileSync(join(packageRoot, "root-bun.ts"), 'export default "root-bun";\n');
  writeFileSync(join(packageRoot, "root-default.ts"), 'export default "wrong-root-default";\n');
  writeFileSync(join(packageRoot, "exact-a.ts"), 'export default "exact-a";\n');
  writeFileSync(join(packageRoot, "bad.ts"), 'export default "wrong-exact-default";\n');
  writeFileSync(join(packageRoot, "features", "b.ts"), 'export default "feature-b";\n');
  writeFileSync(join(packageRoot, "features", "special", "tool.ts"), 'export default "wrong-general-export-special";\n');
  writeFileSync(join(packageRoot, "features", "group", "deep.ts"), 'export default "wrong-general-export-deep";\n');
  writeFileSync(join(packageRoot, "features-special", "tool.ts"), 'export default "feature-special-wildcard";\n');
  writeFileSync(join(packageRoot, "features-deep", "group.ts"), 'export default "feature-deep-wildcard";\n');
  for (let index = 0; index < exactEntryCount; index++) {
    writeFileSync(join(packageRoot, "exact", `${index}.ts`), `export default "export-exact-${index}";\n`);
  }

  const expected = {
    root: "root-bun",
    exact: "exact-a",
    manyExact: `export-exact-${exactExportIndex}`,
    wildcard: "feature-b",
    specialWildcard: "feature-special-wildcard",
    deepWildcard: "feature-deep-wildcard",
    internal: "internal-exact",
    manyInternal: `import-exact-${exactImportIndex}`,
    util: "util-wildcard",
    specialUtil: "util-special-wildcard",
    deepUtil: "util-deep-wildcard",
  };
  expectPackageResolution(undefined, expected);
  expectPackageResolution({ BUN_DX_DISABLE_RESOLVER_INLINE_CONDITIONS_MAP: "1" }, expected);
  expectPackageResolution({ BUN_DX_DISABLE_EXPORTS_EXACT_KEY_INDEX: "1" }, expected);
  expectPackageResolution(
    {
      BUN_DX_DISABLE_RESOLVER_INLINE_CONDITIONS_MAP: "1",
      BUN_DX_DISABLE_EXPORTS_EXACT_KEY_INDEX: "1",
    },
    expected,
  );
});

test("keeps package exports/imports source layout on inline strings and exact-key indexes", () => {
  const packageJson = readFileSync(join(repoRoot, "src", "resolver", "package_json.rs"), "utf8");

  expect(packageJson).toContain("pub enum EntryString");
  expect(packageJson).toContain("Source(&'static [u8])");
  expect(packageJson).toContain("fn from_parser_slice(source: &bun_ast::Source, value: &[u8]) -> Self");
  expect(packageJson).toContain("fn source_subslice(source: &'static [u8], value: &[u8]) -> Option<&'static [u8]>");
  expect(packageJson).toContain("Self::Owned(Box::from(value))");
  const entryStringBlock = blockBetween(packageJson, "pub enum EntryString {", "\n}\n\nimpl EntryString");
  expect([...entryStringBlock.matchAll(/^\s+([A-Z][A-Za-z0-9_]*)/gm)].map((match) => match[1])).toEqual([
    "Empty",
    "Source",
    "Owned",
  ]);
  expect(entryStringBlock).not.toContain("Inline");
  expect(entryStringBlock).not.toContain("SmallVec");
  expect(entryStringBlock).not.toContain("ArrayVec");
  expect(entryStringBlock).not.toContain("TinyVec");

  expect(packageJson).toContain("const INLINE_CONDITIONS_CAPACITY: usize = 12");
  expect(packageJson).toContain("const CONDITIONS_LENGTH_MASK_BITS: usize = u128::BITS as usize");
  expect(packageJson).toContain("pub struct ConditionsMap");
  expect(packageJson).toContain("inline: SmallVec<[Box<[u8]>; INLINE_CONDITIONS_CAPACITY]>");
  expect(packageJson).toContain("map: Option<StringArrayHashMap<()>>");
  expect(packageJson).toContain("length_mask: u128");
  expect(packageJson).toContain("has_long_condition: bool");
  expect(packageJson).toContain("fn remember_key_len(&mut self, key: &[u8])");
  expect(packageJson).toContain("fn may_contain_key_len(&self, len: usize) -> bool");
  expect(packageJson).toContain("if !self.may_contain_key_len(key.len())");
  expect(packageJson).toContain("fn dx_disable_resolver_inline_conditions_map() -> bool");
  expect(packageJson).toContain('std::env::var_os("BUN_DX_DISABLE_RESOLVER_INLINE_CONDITIONS_MAP").is_some()');
  expect(packageJson).toContain("if dx_disable_resolver_inline_conditions_map()");
  expect(packageJson).toContain("if self.inline.len() + additional > INLINE_CONDITIONS_CAPACITY");
  expect(packageJson).toContain("fn promote(&mut self, additional: usize)");
  expect(packageJson).toContain("self.map = Some(map);");

  expect(packageJson).toContain("pub struct EntryDataMapList");
  expect(packageJson).toContain("entries: MultiArrayList<MapEntry>");
  expect(packageJson).toContain("pub expansion_keys: Box<[u32]>");
  expect(packageJson).toContain("let mut expansion_keys: Vec<u32>");
  expect(packageJson).toContain("fn sorted_expansion_key_indices(list: &EntryDataMapList, expansion_keys: &mut [u32])");
  expect(packageJson).not.toContain("let mut expansion_keys: Vec<MapEntry>");
  expect(packageJson).toContain("const EXPORTS_EXACT_KEY_INDEX_MIN_ENTRIES: usize = 128");
  expect(packageJson).toContain("fn dx_disable_exports_exact_key_index() -> bool");
  expect(packageJson).toContain('std::env::var_os("BUN_DX_DISABLE_EXPORTS_EXACT_KEY_INDEX").is_some()');
  expect(packageJson).toContain("pub exact_keys: Box<[u32]>");
  expect(packageJson).toContain("if list.len() >= EXPORTS_EXACT_KEY_INDEX_MIN_ENTRIES");
  expect(packageJson).toContain("fn sorted_key_indices(list: &EntryDataMapList) -> Box<[u32]>");
  expect(packageJson).toContain("if self.exact_keys.is_empty()");
  expect(packageJson).toContain("for entry in self.list.iter()");
  expect(packageJson).toContain(".partition_point(|entry_i| self.list.key(*entry_i as usize).as_ref() < key)");
  expect(packageJson).toContain("fn exact_key_index_builds_for_large_maps_and_preserves_first_duplicate()");
  expect(packageJson).toContain("fn expansion_key_indices_preserve_sorted_key_value_pairs()");
  expect(packageJson).toContain("fn conditions_map_promotes_without_losing_duplicate_or_clone_semantics()");
  expect(packageJson).toContain("if let Some(target) = match_obj.value_for_key(match_key)");
  expect(packageJson).toContain("if strings::index_of_char(&result.path, b'%').is_none()");
  expect(packageJson).toContain("status: Status::UnsupportedDirectoryImport");
});

test("feature benchmark keeps exports and imports above exact-key index threshold", () => {
  const packageJson = readFileSync(join(repoRoot, "src", "resolver", "package_json.rs"), "utf8");
  const benchmark = readFileSync(join(repoRoot, "scripts", "dx-bun-feature-benchmark.ts"), "utf8");
  const threshold = parseRustConst(packageJson, "EXPORTS_EXACT_KEY_INDEX_MIN_ENTRIES");
  const resolverFixture = functionBody(benchmark, "prepareResolverExportsImports");

  expect(parseTsConst(resolverFixture, "exactExportCount")).toBeGreaterThanOrEqual(threshold);
  expect(parseTsConst(resolverFixture, "exactImportCount")).toBeGreaterThanOrEqual(threshold);
  expect(resolverFixture).toContain('exportsMap[`./exact/${i}`]');
  expect(resolverFixture).toContain('imports[`#tool/${i}`]');
  expect(benchmark).toContain("BUN_DX_DISABLE_EXPORTS_EXACT_KEY_INDEX");
});

function resetFixture(): void {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function expectPackageResolution(env: Record<string, string> | undefined, expected: Record<string, string>): void {
  const result = Bun.spawnSync({
    cmd: [localBun, "entry.ts"],
    cwd: fixtureRoot,
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString())).toEqual(expected);
}

function functionBody(source: string, name: string): string {
  const marker = `function ${name}()`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextFunction = source.indexOf("\nfunction ", start + marker.length);
  expect(nextFunction).toBeGreaterThan(start);
  return source.slice(start, nextFunction);
}

function parseRustConst(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name}: usize = (\\d+);`));
  expect(match).not.toBeNull();
  return Number(match![1]);
}

function blockBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function exactKeyIndexThreshold(): number {
  return parseRustConst(
    readFileSync(join(repoRoot, "src", "resolver", "package_json.rs"), "utf8"),
    "EXPORTS_EXACT_KEY_INDEX_MIN_ENTRIES",
  );
}

function parseTsConst(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name} = (\\d+);`));
  expect(match).not.toBeNull();
  return Number(match![1]);
}
