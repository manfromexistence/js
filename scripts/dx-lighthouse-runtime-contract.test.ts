import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDxLighthouseRuntimeContract,
  parseDxLighthouseRuntimeContractArgs,
} from "./dx-lighthouse-runtime-contract.ts";

const repoRoot = join(import.meta.dir, "..");
const buildWorkspace = join(repoRoot, "..", "build");
const scriptPath = join(repoRoot, "scripts", "dx-lighthouse-runtime-contract.ts");

test("describes a metadata-only DX JS Lighthouse contract without scoring claims", () => {
  const packageJson = join(repoRoot, "package.json");
  const existingFiles = new Set([
    slash(packageJson),
    slash(scriptPath),
    slash(join(buildWorkspace, "package.json")),
    slash(join(buildWorkspace, "packages", "bench", "package.json")),
    slash(join(buildWorkspace, "packages", "bench", "receipt", "lighthouse-package-contract.ts")),
    slash(join(buildWorkspace, "packages", "rolldown", "bin", "cli.mjs")),
  ]);
  const existingDirectories = new Set([slash(repoRoot), slash(buildWorkspace)]);

  const contract = buildDxLighthouseRuntimeContract({
    repoRoot,
    buildWorkspace,
    fileExists: path => existingFiles.has(slash(path)),
    directoryExists: path => existingDirectories.has(slash(path)),
    readText: path =>
      slash(path) === slash(packageJson)
        ? '{"scripts":{"dx:lighthouse:contract":"bun --silent ./scripts/dx-lighthouse-runtime-contract.ts"}}'
        : undefined,
  });

  expect(contract.schema_version).toBe("dx.js.lighthouse_contract.v1");
  expect(contract.command).toBe("dx js lighthouse --contract --json");
  expect(contract.package_script).toBe("dx:lighthouse:contract");
  expect(contract.source_script).toBe("scripts/dx-lighthouse-runtime-contract.ts");
  expect(contract.status).toBe("not_ready");
  expect(contract.javascript_runtime.present).toBe(true);
  expect(contract.build_engine.present).toBe(true);
  expect(contract.build_engine.required_files).toContainEqual({
    path: "package.json",
    present: true,
  });
  expect(contract.build_engine.required_files).toContainEqual({
    path: "packages/bench/package.json",
    present: true,
  });
  expect(contract.build_engine.required_files).toContainEqual({
    path: "packages/bench/receipt/lighthouse-package-contract.ts",
    present: true,
  });
  expect(contract.availability).toMatchObject({
    available: false,
    script_available: true,
    dependency_available: false,
    source_tracked_support_available: true,
    receipt_available: false,
    report_available: false,
    lighthouse_build_artifact_available: false,
    fresh_dx_js_package_receipt_available: false,
  });
  expect(contract.official_lighthouse).toMatchObject({
    npm_package: "lighthouse",
    package_present: false,
    node_engine_required: true,
    chrome_headless_required: true,
    lhr_json_required: true,
  });
  expect(contract.execution_contract).toMatchObject({
    package_script_routing: true,
    requires_dx_js_package_json: true,
    executes_lighthouse: false,
    executes_chrome: false,
    writes_receipts: false,
    writes_files: false,
  });
  expect(contract.scoring).toMatchObject({
    dx_js_scores_available: false,
    official_category_scores_required: true,
    score_equivalence_required: true,
    lhr_json_shape_equivalence_required: true,
    fake_scores_allowed: false,
  });
  expect(contract.check_runtime_gate).toEqual({
    runtime_receipt_schema: "dx.check.web_lighthouse_runtimes.v1",
    equivalence_receipt_schema: "dx.check.web_lighthouse_equivalence.v1",
    source_receipt: ".dx/check/web-lighthouse-runtimes.sr",
    machine_receipt: ".dx/serializer/check-web-lighthouse-runtimes.machine",
    equivalence_source_receipt: ".dx/check/web-lighthouse-equivalence.sr",
    equivalence_machine_receipt: ".dx/serializer/check-web-lighthouse-equivalence.machine",
    runtime_table: "web_lighthouse_runtimes",
    runtime_args_table: "web_lighthouse_runtime_args",
    equivalence_table: "web_lighthouse_equivalence",
    package_proof_table: "web_lighthouse_package_proofs",
    runtime_table_columns: [
      "id",
      "provider",
      "command",
      "cwd",
      "executable",
      "hash_blake3",
      "claim_status",
      "equivalence_status",
    ],
    runtime_args_table_columns: ["runtime_id", "position", "arg"],
    equivalence_table_columns: [
      "runtime_id",
      "provider",
      "executable_hash_blake3",
      "status",
      "sample_count",
      "category_scores_match",
      "lhr_json_shape_match",
    ],
    package_proof_table_columns: [
      "runtime_id",
      "provider",
      "package_name",
      "status",
      "build_receipt_hash_blake3",
      "package_assets_filesystem_addressable",
      "dynamic_imports_runtime_compatible",
      "node_builtins_runtime_compatible",
      "chrome_launcher_unstubbed",
    ],
    required_runtime_args: ["js", "lighthouse"],
    required_provider: "dx-js",
    required_package_provider: "dx-build",
    required_package_name: "lighthouse",
    required_claim_status: "proven_bundle",
    required_equivalence_status: "verified",
    required_package_status: "verified",
    required_hash_algorithm: "blake3",
  });
  expect(contract.packaging_contract).toMatchObject({
    runtime_provider: "dx-js",
    build_provider: "dx-build",
    package_name: "lighthouse",
    packaged_command_status: "not_proven",
    package_assets_must_remain_filesystem_addressable: true,
    dynamic_imports_must_remain_runtime_compatible: true,
    node_builtins_must_remain_runtime_compatible: true,
    chrome_launcher_must_not_be_stubbed: true,
    equivalence_receipt_required: true,
    build_contract_command: "node ../build/packages/bench/receipt/lighthouse-package-contract.ts --contract --json",
    build_contract_package_script: "dx:lighthouse:package-contract",
    build_contract_package_script_command: "node ./packages/bench/receipt/lighthouse-package-contract.ts",
    build_contract_receipt_package_script: "receipt:lighthouse-package-contract",
    build_contract_receipt_package_script_command: "node ./receipt/lighthouse-package-contract.ts",
  });
  expect(contract.redaction).toEqual({
    metadata_only: true,
    stores_lhr_json: false,
    stores_traces: false,
    stores_screenshots: false,
    executes_chrome: false,
  });
});

test("does not mark package-script routing ready when the source script or package script is missing", () => {
  const packageJson = join(repoRoot, "package.json");
  const existingDirectories = new Set([slash(repoRoot)]);
  const existingFiles = new Set([slash(packageJson), slash(scriptPath)]);

  const withoutPackageScript = buildDxLighthouseRuntimeContract({
    repoRoot,
    buildWorkspace,
    fileExists: path => existingFiles.has(slash(path)),
    directoryExists: path => existingDirectories.has(slash(path)),
    readText: path => (slash(path) === slash(packageJson) ? '{"scripts":{}}' : undefined),
  });
  expect(withoutPackageScript.availability.script_available).toBe(true);
  expect(withoutPackageScript.execution_contract.package_script_routing).toBe(false);
  expect(withoutPackageScript.execution_contract.requires_dx_js_package_json).toBe(true);

  const withoutSourceScript = buildDxLighthouseRuntimeContract({
    repoRoot,
    buildWorkspace,
    fileExists: path => slash(path) === slash(packageJson),
    directoryExists: path => existingDirectories.has(slash(path)),
    readText: path =>
      slash(path) === slash(packageJson)
        ? '{"scripts":{"dx:lighthouse:contract":"bun --silent ./scripts/dx-lighthouse-runtime-contract.ts"}}'
        : undefined,
  });
  expect(withoutSourceScript.availability.script_available).toBe(false);
  expect(withoutSourceScript.execution_contract.package_script_routing).toBe(false);
  expect(withoutSourceScript.execution_contract.requires_dx_js_package_json).toBe(true);

  const withWrongPackageScript = buildDxLighthouseRuntimeContract({
    repoRoot,
    buildWorkspace,
    fileExists: path => existingFiles.has(slash(path)),
    directoryExists: path => existingDirectories.has(slash(path)),
    readText: path =>
      slash(path) === slash(packageJson)
        ? '{"scripts":{"dx:lighthouse:contract":"bun ./scripts/other-lighthouse-contract.ts"}}'
        : undefined,
  });
  expect(withWrongPackageScript.availability.script_available).toBe(true);
  expect(withWrongPackageScript.execution_contract.package_script_routing).toBe(false);
  expect(withWrongPackageScript.execution_contract.requires_dx_js_package_json).toBe(true);
});

test("keeps the contract not ready when the official Lighthouse package is installed", () => {
  const packageJson = join(repoRoot, "package.json");
  const lighthousePackage = join(repoRoot, "node_modules", "lighthouse", "package.json");
  const existingFiles = new Set([slash(packageJson), slash(scriptPath), slash(lighthousePackage)]);
  const existingDirectories = new Set([slash(repoRoot)]);

  const contract = buildDxLighthouseRuntimeContract({
    repoRoot,
    buildWorkspace,
    fileExists: path => existingFiles.has(slash(path)),
    directoryExists: path => existingDirectories.has(slash(path)),
    readText: path =>
      slash(path) === slash(packageJson)
        ? '{"scripts":{"dx:lighthouse:contract":"bun --silent ./scripts/dx-lighthouse-runtime-contract.ts"}}'
        : undefined,
  });

  expect(contract.status).toBe("not_ready");
  expect(contract.availability).toMatchObject({
    available: false,
    dependency_available: true,
  });
  expect(contract.official_lighthouse.package_present).toBe(true);
  expect(contract.execution_contract.executes_lighthouse).toBe(false);
  expect(contract.scoring.dx_js_scores_available).toBe(false);
});

test("parses only the metadata contract flags", () => {
  expect(parseDxLighthouseRuntimeContractArgs(["--contract", "--json"])).toEqual({
    ok: true,
    mode: "contract_json",
  });
  expect(parseDxLighthouseRuntimeContractArgs(["--json", "--contract"])).toEqual({
    ok: true,
    mode: "contract_json",
  });
  expect(parseDxLighthouseRuntimeContractArgs([])).toEqual({
    ok: false,
    message:
      "DX JS Lighthouse scoring is not ready. Inspect `bun --silent run dx:lighthouse:contract --contract --json` for metadata.",
  });
  expect(parseDxLighthouseRuntimeContractArgs(["--contract"])).toEqual({
    ok: false,
    message: "bun --silent run dx:lighthouse:contract --contract --json requires --json.",
  });
  expect(parseDxLighthouseRuntimeContractArgs(["--contract", "--json", "--score"])).toEqual({
    ok: false,
    message:
      "Unsupported DX JS Lighthouse contract argument `--score`; expected `bun --silent run dx:lighthouse:contract --contract --json`.",
  });
  expect(parseDxLighthouseRuntimeContractArgs(["--contract", "--contract", "--json"])).toEqual({
    ok: false,
    message: "bun --silent run dx:lighthouse:contract --contract --json requires exactly one --contract flag.",
  });
  expect(parseDxLighthouseRuntimeContractArgs(["--contract", "--json", "--json"])).toEqual({
    ok: false,
    message: "bun --silent run dx:lighthouse:contract --contract --json requires exactly one --json flag.",
  });
  expect(parseDxLighthouseRuntimeContractArgs(["--json"])).toEqual({
    ok: false,
    message: "bun --silent run dx:lighthouse:contract --contract --json requires exactly one --contract flag.",
  });
});

test("contract script prints JSON only for the explicit metadata command", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath, "--contract", "--json"],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const contract = JSON.parse(result.stdout.toString());
  expect(contract.schema_version).toBe("dx.js.lighthouse_contract.v1");
  expect(contract.check_runtime_gate).toMatchObject({
    runtime_receipt_schema: "dx.check.web_lighthouse_runtimes.v1",
    equivalence_receipt_schema: "dx.check.web_lighthouse_equivalence.v1",
    source_receipt: ".dx/check/web-lighthouse-runtimes.sr",
    machine_receipt: ".dx/serializer/check-web-lighthouse-runtimes.machine",
    equivalence_source_receipt: ".dx/check/web-lighthouse-equivalence.sr",
    equivalence_machine_receipt: ".dx/serializer/check-web-lighthouse-equivalence.machine",
    runtime_table: "web_lighthouse_runtimes",
    runtime_args_table: "web_lighthouse_runtime_args",
    equivalence_table: "web_lighthouse_equivalence",
    package_proof_table: "web_lighthouse_package_proofs",
    required_runtime_args: ["js", "lighthouse"],
    required_package_provider: "dx-build",
    required_package_name: "lighthouse",
    required_package_status: "verified",
  });
  expect(contract.check_runtime_gate.machine_receipt).toStartWith(".dx/serializer/");
  expect(contract.check_runtime_gate.machine_receipt).toEndWith(".machine");
  expect(contract.check_runtime_gate.equivalence_machine_receipt).toStartWith(".dx/serializer/");
  expect(contract.check_runtime_gate.equivalence_machine_receipt).toEndWith(".machine");
  expect(contract.execution_contract.executes_lighthouse).toBe(false);
  expect(contract.scoring.fake_scores_allowed).toBe(false);

  const rejected = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(rejected.exitCode).toBe(1);
  expect(rejected.stdout.toString()).toBe("");
  expect(rejected.stderr.toString()).toContain("DX JS Lighthouse scoring is not ready");
});

test("package scripts expose the Lighthouse contract without adding Lighthouse as a dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  expect(packageJson.scripts["dx:lighthouse:contract"]).toBe(
    "bun --silent ./scripts/dx-lighthouse-runtime-contract.ts",
  );
  expect(packageJson.scripts["dx:contracts"]).toBe("bun test --timeout 30000 ./scripts/dx-*.test.ts");
  expect(packageJson.dependencies?.lighthouse).toBeUndefined();
  expect(packageJson.devDependencies?.lighthouse).toBeUndefined();
});

test("package script emits machine-readable JSON on stdout", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--silent", "run", "dx:lighthouse:contract", "--contract", "--json"],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString()).schema_version).toBe("dx.js.lighthouse_contract.v1");
});

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}
