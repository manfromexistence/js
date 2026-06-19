import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localBun = join(root, "build", "release", "bun.exe");
const fixture = join(root, ".tmp", "dx-which-path-reuse-contract");

function runLocalBun(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(localBun, args, {
    cwd: fixture,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

test("Windows which path lookup encodes the binary name once before PATH iteration", () => {
  const source = readFileSync(join(root, "src", "which", "lib.rs"), "utf8");

  expect(source).toContain("use bun_paths::w_path_buffer_pool;");
  expect(source).toContain("fn encode_bin_utf16<'a>(");
  expect(source).toContain("fn copy_ascii_to_utf16(buf: &mut [u16], input: &[u8]) -> Option<usize>");
  expect(source).toContain("copy_ascii_to_utf16(&mut buf[..], segment)");
  expect(source).toContain("copy_ascii_to_utf16(&mut buf[..], bin)");
  expect(source).toContain("bun_core::strings::convert_utf8_to_utf16_in_buffer(&mut buf[..], bin)");
  expect(source).toContain("let mut bin_buf = w_path_buffer_pool::get();");
  expect(source).toContain("let bin_utf16 = encode_bin_utf16(");
  expect(source).toContain("search_bin_in_path(");
  expect(source).toContain("bin_utf16,");
  expect(source).toContain("fn dx_disable_which_bin_utf16_reuse() -> bool");
  expect(source).toContain('std::env::var_os("BUN_DX_DISABLE_WHICH_BIN_UTF16_REUSE").is_some()');

  const pathLoop = source.indexOf("for segment_part in path.split(|b| *b == b';').filter(|s| !s.is_empty())");
  const encodedBeforePathLoop = source.lastIndexOf("let bin_utf16 = encode_bin_utf16(", pathLoop);
  expect(encodedBeforePathLoop).toBeGreaterThan(0);
  expect(encodedBeforePathLoop).toBeLessThan(pathLoop);

  const loopBody = source.slice(pathLoop, source.indexOf("None", pathLoop));
  expect(loopBody).not.toContain("convert_utf8_to_utf16_in_buffer(&mut *bin_buf");
});

test("local release Bun.which resolves a late PATH hit through the optimized and rollback paths", () => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });

  const pathParts: string[] = [];
  for (let index = 0; index < 32; index++) {
    const dir = join(fixture, `empty-${index}`);
    mkdirSync(dir, { recursive: true });
    pathParts.push(dir);
  }

  const hitDir = join(fixture, "bin-target");
  mkdirSync(hitDir, { recursive: true });
  writeFileSync(join(hitDir, "dx-tool.cmd"), "@echo off\r\necho dx-tool\r\n");
  pathParts.push(hitDir);

  writeFileSync(
    join(fixture, "which-entry.ts"),
    `
const found = Bun.which("dx-tool", { PATH: process.env.DX_WHICH_PATH! });
console.log("which:" + !!found + ":" + found?.replaceAll("\\\\", "/").endsWith("/dx-tool.cmd"));
`,
  );

  const expected = {
    status: 0,
    stdout: "which:true:true",
    stderr: "",
  };
  const env = { DX_WHICH_PATH: pathParts.join(";") };

  expect(runLocalBun(["which-entry.ts"], env)).toEqual(expected);
  expect(runLocalBun(["which-entry.ts"], { ...env, BUN_DX_DISABLE_WHICH_BIN_UTF16_REUSE: "1" })).toEqual(expected);
});
