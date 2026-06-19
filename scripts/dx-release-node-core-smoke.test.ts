import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const root = join(import.meta.dir, "..");
const fixture = join(root, ".tmp", "dx-release-node-core-smoke");

test("release Bun keeps core Node compatibility for normal app APIs", async () => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });

  const payloadPath = join(fixture, "payload.txt");
  writeFileSync(payloadPath, "dx-node-core");
  const payload = await readFile(payloadPath);
  expect(createHash("sha256").update(payload).digest("hex")).toHaveLength(64);
  expect(gunzipSync(gzipSync(payload)).toString()).toBe("dx-node-core");

  const child = spawnSync(process.execPath, ["-e", "console.log(process.env.DX_NODE_CORE_SMOKE)"], {
    cwd: fixture,
    env: { ...process.env, DX_NODE_CORE_SMOKE: "env-ok" },
    encoding: "utf8",
    windowsHide: true,
  });
  expect(child.status).toBe(0);
  expect(child.stdout.trim()).toBe("env-ok");

  writeFileSync(
    join(fixture, "entry.ts"),
    'const path = require("node:path") as typeof import("node:path");\nconst value: number = 41;\nconsole.log(`${path.basename("nested/file.ts")}:${value + 1}`);\n',
  );
  const interop = spawnSync(process.execPath, [join(fixture, "entry.ts")], {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
  });
  expect(interop.status).toBe(0);
  expect(interop.stdout.trim()).toBe("file.ts:42");

  expect(fileURLToPath(pathToFileURL(payloadPath))).toBe(payloadPath);
  expect(existsSync(payloadPath)).toBe(true);
});
