import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localBun = join(root, "build", "release", "bun.exe");
const fixture = join(root, ".tmp", "dx-runtime-transpiler-cache-contract");
const cacheDir = join(fixture, ".cache");

function runLocalBun(script: string, cwd = fixture, runtimeCacheDir = cacheDir) {
  const result = spawnSync(localBun, [script], {
    cwd,
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: runtimeCacheDir,
      BUN_DEBUG_ENABLE_RESTORE_FROM_TRANSPILER_CACHE: "1",
    },
    encoding: "utf8",
    windowsHide: true,
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function pileFiles(runtimeCacheDir = cacheDir): string[] {
  return readdirSync(runtimeCacheDir)
    .filter((name) => name.endsWith(".pile"))
    .sort();
}

const metadataSize = 4 + 1 + 1 + 12 * 8;
const sourcemapOffsetField = 54;
const sourcemapLengthField = 62;
const sourcemapHashField = 70;
const esmRecordOffsetField = 78;

function readU64LE(bytes: Buffer, offset: number): number {
  return Number(bytes.readBigUInt64LE(offset));
}

function readPileSourcemapRange(bytes: Buffer) {
  return {
    offset: readU64LE(bytes, sourcemapOffsetField),
    length: readU64LE(bytes, sourcemapLengthField),
    hash: readU64LE(bytes, sourcemapHashField),
  };
}

test("runtime transpiler cache keeps MaybeUninit vectored/contiguous read guards wired", () => {
  const source = readFileSync(join(root, "src", "jsc", "RuntimeTranspilerCache.rs"), "utf8");

  expect(source).toContain("Box::<[u8]>::new_uninit_slice");
  expect(source).toContain("fn read_entry_payloads(");
  expect(source).toContain("fn read_entry_payloads_fallback(");
  expect(source).toContain("fn pread_exact(");
  expect(source).toContain("return Err(bun_core::err!(MissingData));");
  expect(source).toContain("checked_add");
  expect(source).toContain("checked_add(len)");

  if (process.platform === "win32") {
    expect(source).toContain("#[cfg(not(unix))]");
    expect(source).toContain("const CONTIGUOUS_READ_MIN_BYTES: usize = 256 * 1024");
    expect(source).toContain("fn read_entry_payloads_contiguous(");
    expect(source).toContain("if total_len < CONTIGUOUS_READ_MIN_BYTES");
    expect(source).toContain("let mut scratch = vec![0; total_len];");
    expect(source).toContain("pread_exact(file, &mut scratch, first_offset)?;");
  } else {
    expect(source).toContain("#[cfg(unix)]");
    expect(source).toContain("fn preadv_exact(");
  }
});

test("runtime transpiler cache retries partial pwritev from the unwritten byte", () => {
  const source = readFileSync(join(root, "src", "jsc", "RuntimeTranspilerCache.rs"), "utf8");

  expect(source).toContain("fn pwritev_exact(");
  expect(source).toContain("fn pwritev_exact_with<W>(");
  expect(source).toContain("mut write_vectored_at: W");
  expect(source).toContain("W: FnMut(Fd, &[sys::PlatformIoVecConst], i64) -> sys::Maybe<usize>");
  expect(source).toContain("fn remaining_pwritev_iovecs(");
  expect(source).toContain("remaining_pwritev_iovecs(payloads, written_total, &mut vecs_buf)");
  expect(source).toContain("pwritev_exact_with(fd, payloads, total_len, sys::pwritev)");
  expect(source).toContain("write_vectored_at(fd, &vecs_buf[0..vecs_i], position)");
  expect(source).toContain("written_total += written;");
  expect(source).toContain("position += i64::try_from(written).expect(\"int cast\");");
  expect(source).toContain("fn pwritev_exact_retries_simulated_short_writes_without_rewriting_bytes()");
  expect(source).toContain("let cap = requested.min(3);");
  expect(source).toContain("assert_eq!(position, cursor);");
  expect(source).not.toContain("sys::pwritev(tmpfile.fd, vecs, position)");
});

test("runtime transpiler cache validates sourcemap payload hashes on load", () => {
  const source = readFileSync(join(root, "src", "jsc", "RuntimeTranspilerCache.rs"), "utf8");

  expect(source).toContain("pub fn validate_payload_layout(&self, stat_size: u64)");
  expect(source).toContain("self.metadata.validate_payload_layout(stat_size)?;");
  expect(source).toContain("self.sourcemap_byte_offset != output_end");
  expect(source).toContain("self.esm_record_byte_offset != sourcemap_end");
  expect(source).toContain("usize::try_from(len)");
  expect(source).toContain("metadata.sourcemap_hash = hash(sourcemap);");
  expect(source).toContain("if self.metadata.sourcemap_hash != 0 {");
  expect(source).toContain("if hash(&sourcemap) != self.metadata.sourcemap_hash");
  expect(source).toContain("return Err(bun_core::err!(InvalidHash));");
  expect(source).toContain("self.sourcemap = sourcemap;");
});

test("local release rejects truncated runtime transpiler cache entries and rewrites them", () => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });

  const padding = Array.from({ length: 700 }, (_, index) => `const pad_${index}: number = ${index};`).join("\n");
  writeFileSync(
    join(fixture, "cache-hit.ts"),
    `
export const answer: number = 42;
${padding}
console.log("runtime-cache:" + answer);
`,
  );

  const first = runLocalBun("cache-hit.ts");
  expect(first).toEqual({ status: 0, stdout: "runtime-cache:42", stderr: "" });

  const entriesAfterFirst = pileFiles();
  expect(entriesAfterFirst.length).toBeGreaterThan(0);
  const cacheFile = join(cacheDir, entriesAfterFirst[0]);
  const originalSize = statSync(cacheFile).size;
  expect(originalSize).toBeGreaterThan(64);

  const second = runLocalBun("cache-hit.ts");
  expect(second).toEqual({ status: 0, stdout: "runtime-cache:42", stderr: "" });
  expect(pileFiles()).toEqual(entriesAfterFirst);

  truncateSync(cacheFile, 8);
  expect(statSync(cacheFile).size).toBe(8);

  const third = runLocalBun("cache-hit.ts");
  expect(third).toEqual({ status: 0, stdout: "runtime-cache:42", stderr: "" });
  expect(pileFiles()).toEqual(entriesAfterFirst);
  expect(statSync(cacheFile).size).toBe(originalSize);
});

test("local release rejects corrupted runtime transpiler sourcemap payloads and rewrites them", () => {
  const sourcemapFixture = join(root, ".tmp", "dx-runtime-transpiler-cache-sourcemap-contract");
  const sourcemapCacheDir = join(sourcemapFixture, ".cache");
  rmSync(sourcemapFixture, { recursive: true, force: true });
  mkdirSync(sourcemapFixture, { recursive: true });

  const padding = Array.from({ length: 700 }, (_, index) => `const sourcemap_pad_${index}: number = ${index};`).join(
    "\n",
  );
  writeFileSync(
    join(sourcemapFixture, "sourcemap-cache-hit.ts"),
    `
export const answer: number = 42;
${padding}
console.log("runtime-cache-sourcemap:" + answer);
`,
  );

  const first = runLocalBun("sourcemap-cache-hit.ts", sourcemapFixture, sourcemapCacheDir);
  expect(first).toEqual({ status: 0, stdout: "runtime-cache-sourcemap:42", stderr: "" });

  const entriesAfterFirst = pileFiles(sourcemapCacheDir);
  expect(entriesAfterFirst.length).toBeGreaterThan(0);
  const cacheEntry = entriesAfterFirst.find((entry) => {
    const bytes = readFileSync(join(sourcemapCacheDir, entry));
    const sourcemap = readPileSourcemapRange(bytes);
    return sourcemap.length > 0 && sourcemap.hash !== 0;
  });
  expect(cacheEntry).toBeDefined();
  const cacheFile = join(sourcemapCacheDir, cacheEntry!);
  const originalBytes = readFileSync(cacheFile);
  expect(originalBytes.length).toBeGreaterThan(metadataSize);

  const sourcemap = readPileSourcemapRange(originalBytes);
  expect(sourcemap.length).toBeGreaterThan(0);
  expect(sourcemap.hash).not.toBe(0);
  expect(sourcemap.offset).toBeGreaterThanOrEqual(metadataSize);
  expect(sourcemap.offset + sourcemap.length).toBeLessThanOrEqual(originalBytes.length);

  const corruptedBytes = Buffer.from(originalBytes);
  corruptedBytes[sourcemap.offset] ^= 0xff;
  writeFileSync(cacheFile, corruptedBytes);
  expect(readFileSync(cacheFile).equals(originalBytes)).toBe(false);

  const second = runLocalBun("sourcemap-cache-hit.ts", sourcemapFixture, sourcemapCacheDir);
  expect(second).toEqual({ status: 0, stdout: "runtime-cache-sourcemap:42", stderr: "" });
  expect(pileFiles(sourcemapCacheDir)).toEqual(entriesAfterFirst);
  expect(readFileSync(cacheFile).equals(originalBytes)).toBe(true);
});

test("local release rejects corrupted runtime transpiler cache metadata layout and rewrites it", () => {
  const layoutFixture = join(root, ".tmp", "dx-runtime-transpiler-cache-layout-contract");
  const layoutCacheDir = join(layoutFixture, ".cache");
  rmSync(layoutFixture, { recursive: true, force: true });
  mkdirSync(layoutFixture, { recursive: true });

  const padding = Array.from({ length: 700 }, (_, index) => `const layout_pad_${index}: number = ${index};`).join(
    "\n",
  );
  writeFileSync(
    join(layoutFixture, "layout-cache-hit.ts"),
    `
export const answer: number = 42;
${padding}
console.log("runtime-cache-layout:" + answer);
`,
  );

  const first = runLocalBun("layout-cache-hit.ts", layoutFixture, layoutCacheDir);
  expect(first).toEqual({ status: 0, stdout: "runtime-cache-layout:42", stderr: "" });

  const entriesAfterFirst = pileFiles(layoutCacheDir);
  expect(entriesAfterFirst.length).toBeGreaterThan(0);
  const cacheEntry = entriesAfterFirst.find((entry) => {
    const bytes = readFileSync(join(layoutCacheDir, entry));
    return readU64LE(bytes, esmRecordOffsetField) > metadataSize;
  });
  expect(cacheEntry).toBeDefined();
  const cacheFile = join(layoutCacheDir, cacheEntry!);
  const originalBytes = readFileSync(cacheFile);

  const corruptedBytes = Buffer.from(originalBytes);
  const impossibleOffset = BigInt(originalBytes.length + 128);
  corruptedBytes.writeBigUInt64LE(impossibleOffset, esmRecordOffsetField);
  writeFileSync(cacheFile, corruptedBytes);
  expect(readFileSync(cacheFile).equals(originalBytes)).toBe(false);

  const second = runLocalBun("layout-cache-hit.ts", layoutFixture, layoutCacheDir);
  expect(second).toEqual({ status: 0, stdout: "runtime-cache-layout:42", stderr: "" });
  expect(pileFiles(layoutCacheDir)).toEqual(entriesAfterFirst);
  expect(readFileSync(cacheFile).equals(originalBytes)).toBe(true);
});

test("local release handles large runtime transpiler cache entries above the Windows contiguous-read threshold", () => {
  const largeFixture = join(root, ".tmp", "dx-runtime-transpiler-cache-large-contract");
  const largeCacheDir = join(largeFixture, ".cache");
  rmSync(largeFixture, { recursive: true, force: true });
  mkdirSync(largeFixture, { recursive: true });

  const payload = "x".repeat(320 * 1024);
  writeFileSync(
    join(largeFixture, "large-cache-hit.ts"),
    `
const payload: string = ${JSON.stringify(payload)};
console.log("runtime-cache-large:" + payload.length);
`,
  );

  const first = runLocalBun("large-cache-hit.ts", largeFixture, largeCacheDir);
  expect(first).toEqual({ status: 0, stdout: "runtime-cache-large:327680", stderr: "" });

  const entriesAfterFirst = pileFiles(largeCacheDir);
  expect(entriesAfterFirst.length).toBeGreaterThan(0);
  const largestCacheFile = entriesAfterFirst
    .map((entry) => ({ entry, size: statSync(join(largeCacheDir, entry)).size }))
    .sort((left, right) => right.size - left.size)[0];
  expect(largestCacheFile.size).toBeGreaterThan(256 * 1024);

  const second = runLocalBun("large-cache-hit.ts", largeFixture, largeCacheDir);
  expect(second).toEqual({ status: 0, stdout: "runtime-cache-large:327680", stderr: "" });
  expect(pileFiles(largeCacheDir)).toEqual(entriesAfterFirst);
});
