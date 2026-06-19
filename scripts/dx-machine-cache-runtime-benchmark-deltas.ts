export type BenchmarkSignal = "signal" | "noisy" | "underpowered";

export type DeltaTargetSummary = {
  target: string;
  trimmedMeanMs: number;
  signal: BenchmarkSignal;
};

export type BenchmarkDelta = {
  baseline: string;
  candidate: string;
  baselineTrimmedMeanMs: number;
  candidateTrimmedMeanMs: number;
  candidateVsBaselinePct: number;
  minMeaningfulEffectPct: number;
  baselineSignal: BenchmarkSignal;
  candidateSignal: BenchmarkSignal;
  rankable: boolean;
  faster: string;
};

const localMachineTargetNames = new Set([
  "local-machine-integrated",
  "local-machine-rooted",
  "local-machine-trust-env",
  "local-machine-trusted",
]);

const minMeaningfulEffectPct = 3;

export function buildDeltas(summaries: DeltaTargetSummary[]): BenchmarkDelta[] {
  const officialBaseline = findTargetSummary(summaries, "official-json");
  const localJsonBaseline = findTargetSummary(summaries, "local-json");

  const deltas: BenchmarkDelta[] = [];
  if (officialBaseline) {
    deltas.push(
      ...buildBaselineDeltas(
        officialBaseline,
        summaries.filter((summary) => summary.target !== officialBaseline.target),
      ),
    );
  }
  if (localJsonBaseline) {
    deltas.push(
      ...buildBaselineDeltas(
        localJsonBaseline,
        summaries.filter((summary) => localMachineTargetNames.has(summary.target)),
      ),
    );
  }
  return deltas;
}

function buildBaselineDeltas(
  baseline: DeltaTargetSummary,
  candidates: DeltaTargetSummary[],
): BenchmarkDelta[] {
  return candidates.map((summary) => {
    const candidateVsBaselinePct = round(
      ((baseline.trimmedMeanMs - summary.trimmedMeanMs) / baseline.trimmedMeanMs) * 100,
    );
    const hasSignal = baseline.signal === "signal" && summary.signal === "signal";
    const hasMeaningfulEffect = Math.abs(candidateVsBaselinePct) >= minMeaningfulEffectPct;
    const rankable = hasSignal && hasMeaningfulEffect;
    return {
      baseline: baseline.target,
      candidate: summary.target,
      baselineTrimmedMeanMs: baseline.trimmedMeanMs,
      candidateTrimmedMeanMs: summary.trimmedMeanMs,
      candidateVsBaselinePct,
      minMeaningfulEffectPct,
      baselineSignal: baseline.signal,
      candidateSignal: summary.signal,
      rankable,
      faster: rankable
        ? summary.trimmedMeanMs < baseline.trimmedMeanMs
          ? summary.target
          : baseline.target
        : hasSignal
          ? "inconclusive"
          : "unranked",
    };
  });
}

function findTargetSummary(
  summaries: DeltaTargetSummary[],
  target: string,
): DeltaTargetSummary | undefined {
  return summaries.find((candidate) => candidate.target === target);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
