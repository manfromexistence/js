import type { DxJsMachineCacheEntry, DxJsMachineCacheIndex } from "./dx-js-package-json-cache.ts";

export type TSConfigPaths = Record<string, readonly string[]>;
export type TSConfigPathEntry = readonly [string, readonly string[]];

export type TSConfigPathPattern = {
  key: string;
  prefix: string;
  suffix: string;
  targets: readonly TSConfigPathTarget[];
};

export type TSConfigPathTarget = {
  raw: string;
  prefix: string;
  suffix: string;
  hasWildcard: boolean;
};

export type TSConfigPathMatcher = {
  exact: Map<string, readonly string[]>;
  patterns: TSConfigPathPattern[];
};

export function precomputeTSConfigPathPatterns(paths: TSConfigPaths): TSConfigPathMatcher {
  return precomputeTSConfigPathPatternEntries(Object.entries(paths));
}

export function precomputeTSConfigPathPatternEntries(entries: readonly TSConfigPathEntry[]): TSConfigPathMatcher {
  const finalPaths = new Map<string, readonly string[]>();
  for (const [key, targets] of entries) {
    finalPaths.set(key, targets);
  }

  const exact = new Map<string, readonly string[]>();
  const patterns: TSConfigPathPattern[] = [];

  for (const [key, targets] of finalPaths) {
    const star = key.indexOf("*");

    if (star === -1) {
      exact.set(key, targets);
      continue;
    }

    patterns.push({
      key,
      prefix: key.slice(0, star),
      suffix: key.slice(star + 1),
      targets: targets.map(precomputeTSConfigPathTarget),
    });
  }

  patterns.sort(
    (left, right) =>
      right.prefix.length - left.prefix.length || right.suffix.length - left.suffix.length,
  );

  return { exact, patterns };
}

export function matchTSConfigPathTargets(
  matcher: TSConfigPathMatcher,
  specifier: string,
): string[] | undefined {
  const exact = matcher.exact.get(specifier);
  if (exact) {
    return [...exact];
  }

  let best: TSConfigPathPattern | undefined;
  for (const pattern of matcher.patterns) {
    if (
      specifier.length < pattern.prefix.length + pattern.suffix.length ||
      !specifier.startsWith(pattern.prefix) ||
      !specifier.endsWith(pattern.suffix)
    ) {
      continue;
    }

    if (
      !best ||
      pattern.prefix.length > best.prefix.length ||
      (pattern.prefix.length === best.prefix.length && pattern.suffix.length > best.suffix.length)
    ) {
      best = pattern;
    }
  }

  if (!best) {
    return undefined;
  }

  const matched = specifier.slice(best.prefix.length, specifier.length - best.suffix.length);
  return best.targets.map((target) =>
    target.hasWildcard ? `${target.prefix}${matched}${target.suffix}` : target.raw,
  );
}

export function filterTSConfigCacheEntries(index: DxJsMachineCacheIndex): DxJsMachineCacheEntry[] {
  return index.entries
    .filter((entry) => {
      const source = normalizeRepoPath(entry.source);
      return entry.kind === "tsconfig" && /(^|\/)(tsconfig|jsconfig)(\..*)?\.json$/i.test(source);
    })
    .map((entry) => ({
      ...entry,
      source: normalizeRepoPath(entry.source),
      machine: normalizeRepoPath(entry.machine),
      metadata: normalizeRepoPath(entry.metadata),
    }));
}

function normalizeRepoPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function precomputeTSConfigPathTarget(target: string): TSConfigPathTarget {
  const star = target.indexOf("*");
  if (star === -1) {
    return {
      raw: target,
      prefix: target,
      suffix: "",
      hasWildcard: false,
    };
  }

  return {
    raw: target,
    prefix: target.slice(0, star),
    suffix: target.slice(star).replace(/^\*+/, ""),
    hasWildcard: true,
  };
}
