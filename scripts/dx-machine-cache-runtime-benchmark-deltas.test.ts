import { expect, test } from "bun:test";
import {
  buildDeltas,
  type BenchmarkSignal,
  type DeltaTargetSummary,
} from "./dx-machine-cache-runtime-benchmark-deltas.ts";

function summary(
  target: string,
  trimmedMeanMs: number,
  signal: BenchmarkSignal = "signal",
): DeltaTargetSummary {
  return {
    target,
    trimmedMeanMs,
    signal,
  };
}

test("machine cache benchmark deltas include same-binary local JSON baselines", () => {
  const deltas = buildDeltas([
    summary("official-json", 100),
    summary("local-json", 120),
    summary("local-machine-integrated", 90),
    summary("local-machine-trusted", 80),
  ]);

  expect(deltas.map((delta) => `${delta.candidate} vs ${delta.baseline}`)).toEqual([
    "local-json vs official-json",
    "local-machine-integrated vs official-json",
    "local-machine-trusted vs official-json",
    "local-machine-integrated vs local-json",
    "local-machine-trusted vs local-json",
  ]);

  expect(deltaFor(deltas, "local-machine-integrated", "local-json")).toMatchObject({
    candidateVsBaselinePct: 25,
    faster: "local-machine-integrated",
    rankable: true,
  });
  expect(deltaFor(deltas, "local-machine-trusted", "local-json")).toMatchObject({
    candidateVsBaselinePct: 33.333,
    faster: "local-machine-trusted",
    rankable: true,
  });
});

test("machine cache benchmark deltas stay unranked when either side is noisy", () => {
  const deltas = buildDeltas([
    summary("official-json", 100),
    summary("local-json", 120, "noisy"),
    summary("local-machine-integrated", 90),
  ]);

  expect(deltaFor(deltas, "local-json", "official-json")).toMatchObject({
    rankable: false,
    faster: "unranked",
  });
  expect(deltaFor(deltas, "local-machine-integrated", "local-json")).toMatchObject({
    rankable: false,
    faster: "unranked",
  });
});

test("machine cache benchmark deltas call sub-noise differences inconclusive", () => {
  const deltas = buildDeltas([
    summary("official-json", 100),
    summary("local-json", 101),
    summary("local-machine-integrated", 99),
  ]);

  expect(deltaFor(deltas, "local-json", "official-json")).toMatchObject({
    candidateVsBaselinePct: -1,
    minMeaningfulEffectPct: 3,
    rankable: false,
    faster: "inconclusive",
  });
  expect(deltaFor(deltas, "local-machine-integrated", "local-json")).toMatchObject({
    candidateVsBaselinePct: 1.98,
    rankable: false,
    faster: "inconclusive",
  });
});

test("machine cache benchmark deltas support target-filtered local-only runs", () => {
  const deltas = buildDeltas([
    summary("local-json", 120),
    summary("local-machine-integrated", 90),
  ]);

  expect(deltas.map((delta) => `${delta.candidate} vs ${delta.baseline}`)).toEqual([
    "local-machine-integrated vs local-json",
  ]);
  expect(deltaFor(deltas, "local-machine-integrated", "local-json")).toMatchObject({
    candidateVsBaselinePct: 25,
    faster: "local-machine-integrated",
    rankable: true,
  });
  expect(buildDeltas([summary("official-json", 100)])).toEqual([]);
});

function deltaFor(
  deltas: ReturnType<typeof buildDeltas>,
  candidate: string,
  baseline: string,
) {
  const delta = deltas.find(
    (item) => item.candidate === candidate && item.baseline === baseline,
  );
  if (!delta) {
    throw new Error(`Missing delta ${candidate} vs ${baseline}`);
  }
  return delta;
}
