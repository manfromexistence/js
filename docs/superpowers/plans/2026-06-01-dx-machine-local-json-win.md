# DX Package Metadata Machine Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local JavaScript tool branch use DX serializer `.machine` only in narrow JSON/config hot paths where it can realistically beat the same local binary's JSON path, then prove `local-machine` versus `local-json` on `.ts` fixtures without comparing against installed or official Bun.

**Architecture:** Keep Bun's resolver behavior stable. DX pre-generates `.machine` artifacts outside runtime, so benchmarks exclude generation. Runtime work must either avoid JSON parsing or avoid the conversion cost that previously ate the serializer win. The first target is `package.json` package metadata because it already has a local machine-cache path and dominates dependency fixture JSON volume. `tsconfig` and `bunfig` stay shadow-only until package metadata has a proven hit path.

**Tech Stack:** Bun resolver Rust, DX serializer `.machine` artifacts, rkyv validation/archived access, mmap-backed reads where already supported, Bun `.ts` benchmark harnesses, PowerShell build scripts.

---

## Findings

- The isolated DX serializer path is already fast. Generation excluded, current proof shows:
  - `small`: 10.92x faster for machine read+validate than JSON parse, 229.11x faster for hot mmap access than JSON parse.
  - `medium`: 12.82x faster for machine read+validate than JSON parse, 154.85x faster for hot mmap access than JSON parse.
  - `large`: 17.73x faster for machine read+validate than JSON parse, 196.53x faster for hot mmap access than JSON parse.
- Previous Bun runtime benchmarks timed full `bun run ./src/entry.ts`, so process startup, TypeScript loading, resolver construction, filesystem checks, and package model construction hid the raw serializer win.
- The current integrated machine path still builds Bun `PackageJSON` objects and resolver maps after reading `.machine`. That adapter/construction cost can cancel the JSON parse savings.
- Some generated package cache artifacts became larger than the original JSON payloads. That is acceptable for pre-generated caches only if runtime avoids redundant reads, copies, and conversions.
- A no-warning benchmark is not enough. We need hit/miss/read counters or a focused proof that the machine path was actually used.

## Scope Guardrails

- Do not rewrite large parts of Bun.
- Do not compare against installed, official, or downloaded Bun for this goal.
- Do not use `.js`, `.mjs`, or `.cjs` benchmark fixtures.
- Do not count `.machine` generation time.
- Do not keep rerunning the same benchmark without a code or measurement change.
- Keep changes small and maintainable. Prefer env-gated diagnostics over always-on runtime overhead.

## Implementation Steps

- [x] Add explicit local-machine hit proof for package metadata reads.
  - Track package machine hits, misses, fallback JSON reads, and trusted-read hits behind a benchmark/debug environment variable.
  - Keep the default production path free of extra formatting, logging, and global contention.
- [x] Add a focused component benchmark that isolates Bun package JSON parse/construction vs DX package machine read/construction.
  - Use only `.ts` harness code.
  - Use small, medium, and large package fixtures.
  - Exclude cache generation.
  - Report the same style of ratios as the serializer proof.
- [x] Reduce the adapter cost in the package machine path.
  - Prefer resolver-ready archived values for exports/imports/browser/conditions where existing code can consume them safely.
  - Avoid reconstructing maps or strings unless the resolver actually needs owned data.
  - Keep fallback JSON behavior unchanged.
- [x] Only after package metadata wins, evaluate `tsconfig` and `bunfig`.
  - They remain shadow-probed unless a narrow read path proves real runtime value.
  - Do not widen scope if package metadata already proves the goal.
- [x] Build and test with bounded commands.
  - Run focused Bun script tests for machine-cache contracts.
  - Run focused Rust checks for resolver changes if they fit the machine budget.
  - Run one release build with 6 jobs only after code-level checks pass.
- [x] Benchmark local-only.
  - Targets: `local-json` and `local-machine`.
  - Fixtures: `.ts` only, small/medium/large.
  - Attempts: at most two release benchmark rounds after implementation.
  - Stop immediately on clear rankable win or concrete blocker evidence.
- [x] Commit and push.
  - Commit only related files.
  - Push `dev`.
  - Mark the goal complete only after proof is written and committed, or mark blocked only with concrete evidence.

## Current Proof

Current proof uses release binary `build/release-proof-a3bf895c944e-20260601-151841/bun.exe`, revision `1.4.0-canary.1+a3bf895c9`, SHA256 `5793A93A275D5BF144B953FD21ACCF5064280014CEB71350891A3541188160E0`.

| case   | package JSON bytes | `local-json` | `local-machine` | improvement |  speedup |
| ------ | -----------------: | -----------: | --------------: | ----------: | -------: |
| small  |        `132,022` B |   `14.143ms` |       `7.383ms` |     `47.8%` | `1.916x` |
| medium |      `2,099,346` B |   `30.103ms` |      `13.940ms` |     `53.7%` | `2.159x` |
| large  |     `16,781,714` B |   `70.668ms` |      `27.903ms` |     `60.5%` | `2.533x` |

The benchmark recorded `64/64`, `128/128`, and `256/256` package metadata reads hitting `.machine` for the small, medium, and large fixtures. Normal reads and source-validation reads were zero for those measured machine-path runs.

## Success Criteria Status

- Required: machine hit counters prove the local-machine benchmark used `.machine` for package metadata. Status: complete.
- Required: local-machine beats local-json on the focused component benchmark with generation excluded. Status: complete.
- Target: local-machine beats local-json by at least 10% on medium or large component/package metadata workload. Status: complete.
- Stretch: full `bun run` fixture shows a rankable local-machine win on medium or large. Status: deferred; this plan's completed proof is the package metadata path.
- Blocker policy: if component proof is strong but full runtime stays flat, record that process/runtime overhead dominates the narrow path and stop instead of looping.

## Verification Commands

- `bun test --timeout 20000 ./scripts/dx-machine-cache-runtime-benchmark-deltas.test.ts ./scripts/dx-machine-cache-shadow-contract.test.ts`
- Focused Rust resolver check selected after the touched files are known.
- Release build with 6 jobs using the repo's existing build script.
- One local-only `.ts` benchmark pass for small, medium, and large fixtures.
- `git diff --check`
