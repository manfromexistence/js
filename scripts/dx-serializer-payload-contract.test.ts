import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

type SerializerEvidenceLock = {
  schema: string;
  serializerRootHint: string;
  gitBacked: boolean;
  cargoPackage: {
    name: string;
    version: string;
    edition: string;
    rustVersion: string;
  };
  buildContract: {
    bin: string;
    cargoArgs: string[];
    runtimeArgs: string[];
  };
  files: Array<{
    path: string;
    bytes: number;
    sha256: string;
    reason: string;
  }>;
};

const serializerRoot = process.env.DX_SERIALIZER_ROOT ?? resolve(import.meta.dir, "..", "..", "serializer");
const serializerExists = existsSync(serializerRoot);
const allowMissingSerializer = process.env.DX_ALLOW_MISSING_SERIALIZER === "1";
const serializerContractTest = serializerExists ? test : test.skip;

function readSerializerFile(relativePath: string): string {
  return readFileSync(join(serializerRoot, ...relativePath.split("/")), "utf8");
}

function readSerializerBytes(relativePath: string): Buffer {
  return readFileSync(join(serializerRoot, ...relativePath.split("/")));
}

function readEvidenceLock(): SerializerEvidenceLock {
  return JSON.parse(readFileSync(join(import.meta.dir, "dx-serializer-evidence-lock.json"), "utf8"));
}

function assertSafeEvidencePath(relativePath: string): void {
  const parts = relativePath.split("/");
  if (
    relativePath.includes("\\") ||
    isAbsolute(relativePath) ||
    parts.length === 0 ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe serializer evidence path: ${relativePath}`);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("serializer evidence root is available unless explicitly waived", () => {
  if (!serializerExists && !allowMissingSerializer) {
    throw new Error(
      `Missing serializer evidence root: ${serializerRoot}. Set DX_SERIALIZER_ROOT to the serializer tree, or set DX_ALLOW_MISSING_SERIALIZER=1 to make this an explicit waiver.`,
    );
  }

  expect(serializerExists || allowMissingSerializer).toBe(true);
});

serializerContractTest("pins the external serializer source snapshot used as Bun evidence", () => {
  const lock = readEvidenceLock();
  expect(lock.schema).toBe("dx.serializer.external_evidence_lock.v1");
  expect(lock.serializerRootHint).toBe("G:/dx/serializer");
  expect(lock.gitBacked).toBe(false);
  expect(lock.cargoPackage).toEqual({
    name: "dx-serializer",
    version: "0.1.0",
    edition: "2024",
    rustVersion: "1.85",
  });
  expect(lock.buildContract.bin).toBe("dx-serialize");
  expect(lock.buildContract.cargoArgs).toContain("--locked");
  expect(lock.buildContract.cargoArgs).toContain("--features");
  expect(lock.buildContract.cargoArgs).toContain("parallel");
  expect(lock.buildContract.runtimeArgs).toEqual(
    expect.arrayContaining(["--js-cache", "--machine-only", "--metadata", "--write-js-cache-artifacts"]),
  );
  expect(lock.files.length).toBeGreaterThanOrEqual(18);

  const paths = lock.files.map((file) => file.path);
  expect(paths).toEqual([...paths].sort((left, right) => left.localeCompare(right)));
  expect(new Set(paths).size).toBe(paths.length);

  for (const file of lock.files) {
    assertSafeEvidencePath(file.path);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.reason).toBeString();
    expect(file.reason.length).toBeGreaterThan(20);

    const bytes = readSerializerBytes(file.path);
    const actualStat = statSync(join(serializerRoot, ...file.path.split("/")));
    const actualSha256 = sha256(bytes);
    if (actualStat.size !== file.bytes || actualSha256 !== file.sha256) {
      throw new Error(
        [
          `Serializer evidence drift for ${file.path}`,
          `expected bytes=${file.bytes} sha256=${file.sha256}`,
          `actual bytes=${actualStat.size} sha256=${actualSha256}`,
          "Update scripts/dx-serializer-evidence-lock.json only after reviewing the external serializer change.",
        ].join("\n"),
      );
    }
  }
});

serializerContractTest("keeps no-compression and fallback machine payloads borrowed until envelope encoding", () => {
  const convert = readSerializerFile("src/llm/convert.rs");

  expect(convert).toContain("use std::borrow::Cow;");
  expect(convert).toContain("let (codec, payload): (MachineEnvelopeCodec, Cow<'_, [u8]>)");
  expect(convert).toContain("CompressionAlgorithm::None => (MachineEnvelopeCodec::None, Cow::Borrowed(&rkyv_data))");
  expect(convert).toContain("(MachineEnvelopeCodec::None, Cow::Borrowed(&rkyv_data))");
  expect(convert).toContain("payload.as_ref()");
  expect(convert).toContain("fn encode_machine_envelope(");
});
