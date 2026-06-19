import * as path from "node:path";

export function normalizeDxCachePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");

  if (
    /^[a-z]:\//i.test(normalized) ||
    /^[a-z]:/i.test(normalized) ||
    normalized.includes(":") ||
    normalized.startsWith("//") ||
    normalized.startsWith("/")
  ) {
    throw new Error(`DX cache paths must be repo-relative: ${value}`);
  }

  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error(`DX cache paths must stay inside the repo: ${value}`);
  }

  return parts.join("/");
}

export function toDxStatCacheKey(
  root: string,
  repoPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const absolute = path.posix.join(normalizedRoot, normalizeDxCachePath(repoPath));
  const slashPath = absolute.replaceAll("\\", "/");

  return platform === "win32" ? slashPath.toLowerCase() : slashPath;
}
