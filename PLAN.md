# DX JavaScript Machine Cache Plan

This document tracks the current DX package metadata `.machine` cache work for the local JavaScript tool branch. It intentionally focuses on same-binary `local-json` versus `local-machine` evidence. Installed or official Bun releases can be useful context, but they are not the proof target for this branch because they may represent a different upstream snapshot.

## Current Status

The completed slice is the package metadata machine-cache integration for packages inside `node_modules`. The runtime can read DX-generated package metadata from `.machine` artifacts, validate the path through explicit hit counters, and fall back to the existing JSON behavior when the cache is absent or invalid.

Current proof uses release binary `build/release-proof-a3bf895c944e-20260601-151841/bun.exe`, revision `1.4.0-canary.1+a3bf895c9`, SHA256 `5793A93A275D5BF144B953FD21ACCF5064280014CEB71350891A3541188160E0`.

| case   | package JSON bytes | `local-json` | `local-machine` | improvement |  speedup |
| ------ | -----------------: | -----------: | --------------: | ----------: | -------: |
| small  |        `132,022` B |   `14.143ms` |       `7.383ms` |     `47.8%` | `1.916x` |
| medium |      `2,099,346` B |   `30.103ms` |      `13.940ms` |     `53.7%` | `2.159x` |
| large  |     `16,781,714` B |   `70.668ms` |      `27.903ms` |     `60.5%` | `2.533x` |

Machine-cache hit proof:

| case   | package metadata hits |
| ------ | --------------------- |
| small  | `64/64`               |
| medium | `128/128`             |
| large  | `256/256`             |

Benchmark constraints:

- `.machine` generation is excluded from runtime timing.
- Process startup is excluded.
- Fixtures are TypeScript-only.
- The comparison is local release binary JSON path versus the same binary's machine path.
- Proof logging is opt-in and used only for benchmark validation.

Proof artifacts:

- `.tmp/dx-local-json-vs-machine-benchmark-summary.md`
- `.tmp/dx-local-json-vs-machine-benchmark-results.json`
- `scripts/dx-local-json-vs-machine-benchmark.ts`
- `build/release-proof-a3bf895c944e-20260601-151841/bun.exe`

## Implemented Scope

The completed work is intentionally narrow and production-oriented:

- use DX `.machine` package metadata only where it can replace real package metadata JSON reads;
- preserve existing resolver behavior for missing, invalid, unsupported, or out-of-date cache entries;
- keep diagnostics behind benchmark/debug controls;
- keep official/stable release comparisons out of the branch success criteria;
- keep benchmark fixtures in `.ts` files.

## Operating Rules

Future work should follow these constraints:

- do not rewrite broad parts of Bun to chase a narrow benchmark;
- do not count DX cache generation in runtime comparisons;
- do not compare this branch against an installed official release when proving this specific patch;
- do not rerun the same benchmark repeatedly without a code, fixture, or measurement change;
- keep generated cache artifacts outside hand-authored source unless the repository adds a formal generation workflow.

## Next Work

1. Evaluate whether `tsconfig` and `jsconfig` reads have enough repeated runtime cost to justify the same machine-cache treatment.
2. Prototype a resolver-ready archived arena for package metadata to reduce owned object construction after machine reads.
3. Keep workspace, install, and dependency-manifest cache experiments separate from the package metadata path.
4. Add more focused regression fixtures only when they protect a real resolver behavior boundary.
5. Re-run release proof only after a meaningful implementation change.

## Completion Criteria For Future Slices

A future machine-cache slice is complete only when it has:

- a same-binary `local-json` versus `local-machine` benchmark;
- explicit hit, miss, and fallback counters showing the machine path was used;
- TypeScript-only fixtures for this branch's benchmark harness;
- focused tests for fallback behavior and stale cache rejection;
- a professional commit containing only the related implementation, tests, and documentation.
