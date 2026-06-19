import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const repoRoot = join(import.meta.dir, "..");
const localBun = join(repoRoot, "build", "release", "bun.exe");
const fixtureRoot = join(repoRoot, ".tmp", "dx-libdeflate-extract-pool-contract");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, ...relativePath.split("/")), "utf8");
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deterministicBytes(seed: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  buffer.write(encoded.slice(-length + 1), offset, "ascii");
  buffer[offset + length - 1] = 0;
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function createGzipTarball(entries: Array<{ name: string; body: string | Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body);
    chunks.push(tarHeader(entry.name, body.length));
    chunks.push(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function runBun(args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(localBun, args, {
    cwd,
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

function installedPackageSignature(cwd: string, packageName: string) {
  const packageRoot = join(cwd, "node_modules", packageName);
  const packageJsonPath = join(packageRoot, "package.json");
  const indexPath = join(packageRoot, "index.js");
  const payloadPath = join(packageRoot, "payload.bin");
  const lockfilePath = join(cwd, "bun.lock");

  expect(existsSync(packageJsonPath)).toBe(true);
  expect(existsSync(indexPath)).toBe(true);
  expect(existsSync(payloadPath)).toBe(true);
  expect(existsSync(lockfilePath)).toBe(true);

  const required = runBun(["-e", `console.log(require(${JSON.stringify(packageName)}))`], cwd);
  expect(required.status).toBe(0);
  expect(required.stderr).toBe("");

  return {
    packageJson: JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string; main?: string },
    indexSha256: sha256(readFileSync(indexPath)),
    payloadSha256: sha256(readFileSync(payloadPath)),
    required: required.stdout,
  };
}

test("keeps tarball gzip extraction on a reusable libdeflate decompressor slot with zlib fallback", () => {
  const extractTarball = readRepoFile("src/install/extract_tarball.rs");

  expect(extractTarball).toContain("struct LibdeflateDecompressorSlot");
  expect(extractTarball).toContain("thread_local!");
  expect(extractTarball).toContain("static LIBDEFLATE_DECOMPRESSOR");
  expect(extractTarball).toContain("struct PooledLibdeflateDecompressor");
  expect(extractTarball).toContain("fn get() -> Option<Self>");
  expect(extractTarball).toContain('const DX_DISABLE_LIBDEFLATE_EXTRACT_POOL_ENV: &str = "BUN_DX_DISABLE_LIBDEFLATE_EXTRACT_POOL";');
  expect(extractTarball).toContain("fn dx_disable_libdeflate_extract_pool() -> bool");
  expect(extractTarball).toContain("std::env::var_os(DX_DISABLE_LIBDEFLATE_EXTRACT_POOL_ENV).is_some()");
  expect(extractTarball).toContain("pooled: bool");
  expect(extractTarball).toContain("Self { ptr, pooled: false }");
  expect(extractTarball).toContain("Self { ptr, pooled: true }");
  expect(extractTarball).toContain("if !self.pooled");
  expect(extractTarball).toContain("slot.0.take()");
  expect(extractTarball).toContain("fn drop(&mut self)");
  expect(extractTarball).toContain("slot.0.set(Some(self.ptr));");
  expect(extractTarball).toContain("decompress_to_vec(");
  expect(extractTarball).toContain("libdeflate::Encoding::Gzip");
  expect(extractTarball).toContain("u32::from_le_bytes(");
  expect(extractTarball).toContain("Zlib::ZlibReaderArrayList::init(");
  expect(extractTarball).toContain("If libdeflate fails for any reason, fallback to zlib.");
});

test("local release installs the same gzip tarball with libdeflate pool enabled and disabled", () => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });

  const packageName = "dx-libdeflate-behavior-pkg";
  const tarballName = `${packageName}-1.0.0.tgz`;
  const template = join(fixtureRoot, "template");
  mkdirSync(template, { recursive: true });
  writeFileSync(
    join(template, tarballName),
    createGzipTarball([
      {
        name: "package/package.json",
        body: JSON.stringify({ name: packageName, version: "1.0.0", main: "index.js" }, null, 2) + "\n",
      },
      {
        name: "package/index.js",
        body: "module.exports = 12345;\n",
      },
      {
        name: "package/payload.bin",
        body: deterministicBytes(28, 64 * 1024),
      },
    ]),
  );

  const runs: Array<{ name: string; env: Record<string, string> }> = [
    { name: "pool-on", env: {} },
    { name: "pool-off", env: { BUN_DX_DISABLE_LIBDEFLATE_EXTRACT_POOL: "1" } },
  ];
  const signatures = [];

  for (const run of runs) {
    const cwd = join(fixtureRoot, run.name);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: `dx-libdeflate-${run.name}`, private: true, dependencies: { [packageName]: `file:../template/${tarballName}` } }, null, 2) + "\n",
    );

    const install = runBun(["install", "--ignore-scripts", "--cache-dir", join(cwd, ".bun-cache")], cwd, run.env);
    expect(install.status).toBe(0);
    expect(install.stderr).not.toContain("error:");
    signatures.push(installedPackageSignature(cwd, packageName));
  }

  expect(signatures[0]).toEqual(signatures[1]);
  expect(signatures[0].packageJson).toEqual({ name: packageName, version: "1.0.0", main: "index.js" });
  expect(signatures[0].required).toBe("12345");
});
