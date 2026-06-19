import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localBun = join(root, "build", "release", "bun.exe");
const fixture = join(root, ".tmp", "dx-simd-char-frequency-contract");

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function runLocalBun(args: string[]) {
  const result = spawnSync(localBun, args, {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

test("production char-frequency scan stays wired to bun_highway while tests keep scalar reference path", () => {
  const charFreq = readRepoFile("src/ast/char_freq.rs");
  const highway = readRepoFile("src/highway/lib.rs");
  const highwayStrings = readRepoFile("src/jsc/bindings/highway_strings.cpp");
  const parser = readRepoFile("src/js_parser/p.rs");
  const printer = readRepoFile("src/js_printer/lib.rs");
  const renameSymbols = readRepoFile("src/bundler/linker_context/renameSymbolsInChunk.rs");

  expect(charFreq).toContain("const SCAN_BIG_CHUNK_SIZE: usize = 32;");
  expect(charFreq).toContain('const DISABLE_SIMD_CHAR_FREQUENCY_ENV: &str = "BUN_DX_DISABLE_SIMD_CHAR_FREQUENCY";');
  expect(charFreq).toContain("if text.len() < SCAN_BIG_CHUNK_SIZE");
  expect(charFreq).toContain("#[cfg(test)]");
  expect(charFreq).toContain("scan_big_portable(out, text, delta);");
  expect(charFreq).toContain("#[cfg(not(test))]");
  expect(charFreq).toContain("fn simd_char_frequency_disabled() -> bool");
  expect(charFreq).toContain("static DISABLED: std::sync::OnceLock<bool>");
  expect(charFreq).toContain("std::env::var_os(DISABLE_SIMD_CHAR_FREQUENCY_ENV).is_some()");
  expect(charFreq).toContain("if simd_char_frequency_disabled()");
  expect(charFreq).toContain("bun_highway::scan_char_frequency(text, out, delta);");

  const scanBig = charFreq.slice(charFreq.indexOf("fn scan_big("), charFreq.indexOf("fn scan_small("));
  expect(scanBig).toContain("debug_assert!(text.len() >= SCAN_BIG_CHUNK_SIZE);");
  expect(scanBig.indexOf("scan_big_portable")).toBeLessThan(scanBig.indexOf("bun_highway::scan_char_frequency"));

  expect(highway).toContain("pub fn scan_char_frequency(text: &[u8], freqs: &mut [i32; 64], delta: i32)");
  expect(highway).toContain("fn highway_char_frequency(text: *const u8, text_len: usize, freqs: *mut i32, delta: i32);");
  expect(highway).toContain("highway_char_frequency(text.as_ptr(), text.len(), freqs.as_mut_ptr(), delta);");
  expect(highwayStrings).toContain("ScanCharFrequencyImpl");
  expect(highwayStrings).toContain("HWY_EXPORT(ScanCharFrequencyImpl)");
  expect(highwayStrings).toContain("HWY_DYNAMIC_DISPATCH(ScanCharFrequencyImpl)");
  expect(parser).toContain("fn compute_character_frequency(&mut self) -> Option<js_ast::CharFreq>");
  expect(parser).toContain("freq.scan(&self.source.contents, 1);");
  expect(renameSymbols).toContain("AstFlags::HAS_CHAR_FREQ");
  expect(renameSymbols).toContain("freq.include(&char_freq_col[source_index as usize]);");
  expect(renameSymbols).toContain("let minifier = freq.compile();");
  expect(printer).toContain("minify_renamer.assign_names_by_frequency(&minifier)?;");
});

test("local release minifier exercises the production char-frequency renamer path", () => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });

  const entry = join(fixture, "entry.ts");
  writeFileSync(
    entry,
    `
const alphaCounter = 1;
const betaCounter = 2;
const gammaCounter = 3;
const deltaCounter = 4;
function combineVeryLongIdentifierName(firstValue: number, secondValue: number) {
  const repeatedCharacterPressure = firstValue + secondValue + alphaCounter + betaCounter + gammaCounter + deltaCounter;
  return repeatedCharacterPressure * repeatedCharacterPressure;
}
console.log(combineVeryLongIdentifierName(5, 6));
`,
  );

  const entryForBun = entry.replaceAll("\\", "/");
  const script = `
const result = await Bun.build({ entrypoints: [${JSON.stringify(entryForBun)}], minify: true, write: false });
if (!result.success) {
  console.error(result.logs.map((log) => String(log)).join("\\n"));
  process.exit(1);
}
console.log(await result.outputs[0].text());
`;
  const result = runLocalBun(["-e", script]);

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("console.log(");
  expect(result.stdout).not.toContain("combineVeryLongIdentifierName");
  expect(result.stdout).not.toContain("repeatedCharacterPressure");
});
