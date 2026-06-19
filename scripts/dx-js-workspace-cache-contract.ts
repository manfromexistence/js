import { normalizeDxCachePath } from "./dx-js-cache-path-contract.ts";
import type { DxJsMachineCacheEntry, DxJsMachineCacheIndex } from "./dx-js-package-json-cache.ts";

export type WorkspacePackagePlan = {
  inputs: string[];
  maxParallelJobs: number;
  skippedRecursivePatterns: string[];
};

export type WorkspacePackagePlanOptions = {
  maxParallelJobs?: number;
  maxWorkspacePackages?: number;
};

const ignoredWorkspaceDirectoryNames = new Set([".git", "CMakeFiles", "node_modules"]);

export function planWorkspacePackageInputs(
  workspacePatterns: readonly string[],
  discoveredPackageDirectories: readonly string[],
  options: WorkspacePackagePlanOptions = {},
): WorkspacePackagePlan {
  const maxParallelJobs = Math.max(1, options.maxParallelJobs ?? 1);
  const maxWorkspacePackages = Math.max(0, options.maxWorkspacePackages ?? 128);
  const inputs: string[] = [];
  const seenInputs = new Set<string>();
  const skippedRecursivePatterns: string[] = [];
  const discovered = discoveredPackageDirectories.map(normalizeDxCachePath);

  for (const rawPattern of workspacePatterns) {
    const pattern = normalizeDxCachePath(rawPattern);

    if (pattern.includes("**")) {
      skippedRecursivePatterns.push(pattern);
      continue;
    }

    if (!pattern.includes("*")) {
      addInput(inputs, seenInputs, `${pattern}/package.json`);
      continue;
    }

    for (const workspaceDir of matchingWorkspaceDirectories(pattern, discovered).slice(0, maxWorkspacePackages)) {
      addInput(inputs, seenInputs, `${workspaceDir}/package.json`);
    }
  }

  return { inputs, maxParallelJobs, skippedRecursivePatterns };
}

export function filterWorkspacePackageCacheEntries(index: DxJsMachineCacheIndex): DxJsMachineCacheEntry[] {
  return index.entries
    .filter((entry) => {
      const source = normalizeDxCachePath(entry.source);
      return entry.kind === "package_json" && source !== "package.json" && source.endsWith("/package.json");
    })
    .map(normalizeEntry);
}

export function filterBunfigCacheEntries(index: DxJsMachineCacheIndex): DxJsMachineCacheEntry[] {
  return index.entries
    .filter((entry) => {
      const source = normalizeDxCachePath(entry.source);
      return entry.kind === "bunfig" && /(^|\/)bunfig(\..*)?\.toml$/i.test(source);
    })
    .map(normalizeEntry);
}

function matchingWorkspaceDirectories(pattern: string, discoveredPackageDirectories: readonly string[]): string[] {
  const [prefix, suffix = ""] = pattern.split("*", 2);

  return discoveredPackageDirectories
    .filter((dir) => dir.startsWith(prefix) && dir.endsWith(suffix))
    .filter((dir) => {
      const matched = dir.slice(prefix.length, dir.length - suffix.length);
      return matched.length > 0 && !matched.includes("/");
    })
    .filter((dir) => !ignoredWorkspaceDirectoryNames.has(dir.split("/").at(-1) ?? ""))
    .sort((left, right) => left.localeCompare(right));
}

function addInput(inputs: string[], seenInputs: Set<string>, input: string): void {
  const normalized = normalizeDxCachePath(input);
  const key = normalized.toLowerCase();

  if (seenInputs.has(key)) {
    return;
  }

  seenInputs.add(key);
  inputs.push(normalized);
}

function normalizeEntry(entry: DxJsMachineCacheEntry): DxJsMachineCacheEntry {
  return {
    ...entry,
    machine: normalizeDxCachePath(entry.machine),
    metadata: normalizeDxCachePath(entry.metadata),
    source: normalizeDxCachePath(entry.source),
  };
}
