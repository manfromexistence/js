import { expect, test } from "bun:test";
import { normalizeDxCachePath, toDxStatCacheKey } from "./dx-js-cache-path-contract.ts";

test("normalizes cache paths to repo-relative slash paths", () => {
  expect(normalizeDxCachePath(".\\packages\\pkg\\package.json")).toBe("packages/pkg/package.json");
  expect(normalizeDxCachePath("./tsconfig.json")).toBe("tsconfig.json");
});

test("rejects absolute and parent-traversal cache paths", () => {
  expect(() => normalizeDxCachePath("G:\\dx\\bun\\package.json")).toThrow("repo-relative");
  expect(() => normalizeDxCachePath("G:dx\\bun\\package.json")).toThrow("repo-relative");
  expect(() => normalizeDxCachePath("package.json:stream")).toThrow("repo-relative");
  expect(() => normalizeDxCachePath("..\\package.json")).toThrow("inside the repo");
});

test("creates stable Windows stat cache keys", () => {
  expect(toDxStatCacheKey("G:\\Dx\\Bun", "Packages\\Pkg\\package.json", "win32")).toBe(
    "g:/dx/bun/packages/pkg/package.json",
  );
});
