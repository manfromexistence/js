export type StaticLookupInput = {
  key: string;
  value: string;
};

export type StaticLookupEntry = StaticLookupInput;

export type StaticLookupTable = {
  entries: StaticLookupEntry[];
};

export type StaticLookupOptions = {
  stripNodePrefix?: boolean;
};

export function buildStaticLookupTable(
  inputs: readonly StaticLookupInput[],
  options: StaticLookupOptions = {},
): StaticLookupTable {
  const seen = new Set<string>();
  const entries = inputs
    .map((input) => ({
      key: normalizeStaticKey(input.key, options),
      value: input.value,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));

  for (const entry of entries) {
    if (seen.has(entry.key)) {
      throw new Error(`Duplicate static lookup key: ${entry.key}`);
    }
    seen.add(entry.key);
  }

  return { entries };
}

export function lookupStaticEntry(
  table: StaticLookupTable,
  key: string,
  options: StaticLookupOptions = { stripNodePrefix: true },
): StaticLookupEntry | undefined {
  const normalized = normalizeStaticKey(key, options);
  return table.entries.find((entry) => entry.key === normalized);
}

function normalizeStaticKey(key: string, options: StaticLookupOptions): string {
  const trimmed = key.trim();

  if (!trimmed) {
    throw new Error("Static lookup keys must not be empty");
  }

  return options.stripNodePrefix && trimmed.startsWith("node:") ? trimmed.slice("node:".length) : trimmed;
}
