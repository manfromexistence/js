import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type DxLighthouseRuntimeContract = {
  schema_version: "dx.js.lighthouse_contract.v1";
  command: "dx js lighthouse --contract --json";
  package_script: "dx:lighthouse:contract";
  source_script: "scripts/dx-lighthouse-runtime-contract.ts";
  status: "not_ready";
  summary: string;
  javascript_runtime: ToolchainWorkspaceStatus;
  build_engine: ToolchainWorkspaceStatus;
  availability: LighthouseAvailabilityStatus;
  official_lighthouse: OfficialLighthouseStatus;
  execution_contract: LighthouseExecutionContract;
  scoring: LighthouseScoringStatus;
  check_runtime_gate: CheckRuntimeGate;
  packaging_contract: LighthousePackagingContract;
  next_actions: string[];
  blockers: string[];
  redaction: LighthouseContractRedaction;
};

export type ToolchainWorkspaceStatus = {
  id: string;
  path: string;
  present: boolean;
  required_files: ToolchainFileStatus[];
};

export type ToolchainFileStatus = {
  path: string;
  present: boolean;
};

export type LighthouseAvailabilityStatus = {
  available: boolean;
  script_available: boolean;
  dependency_available: boolean;
  source_tracked_support_available: boolean;
  receipt_available: boolean;
  report_available: boolean;
  lighthouse_build_artifact_available: boolean;
  fresh_dx_js_package_receipt_available: boolean;
};

export type OfficialLighthouseStatus = {
  npm_package: "lighthouse";
  package_present: boolean;
  node_engine_required: true;
  chrome_headless_required: true;
  lhr_json_required: true;
};

export type LighthouseExecutionContract = {
  package_script_routing: boolean;
  requires_dx_js_package_json: boolean;
  executes_lighthouse: false;
  executes_chrome: false;
  writes_receipts: false;
  writes_files: false;
};

export type LighthouseScoringStatus = {
  dx_js_scores_available: false;
  official_category_scores_required: true;
  score_equivalence_required: true;
  lhr_json_shape_equivalence_required: true;
  fake_scores_allowed: false;
};

export type CheckRuntimeGate = {
  runtime_receipt_schema: "dx.check.web_lighthouse_runtimes.v1";
  equivalence_receipt_schema: "dx.check.web_lighthouse_equivalence.v1";
  source_receipt: ".dx/check/web-lighthouse-runtimes.sr";
  machine_receipt: ".dx/serializer/check-web-lighthouse-runtimes.machine";
  equivalence_source_receipt: ".dx/check/web-lighthouse-equivalence.sr";
  equivalence_machine_receipt: ".dx/serializer/check-web-lighthouse-equivalence.machine";
  runtime_table: "web_lighthouse_runtimes";
  runtime_args_table: "web_lighthouse_runtime_args";
  equivalence_table: "web_lighthouse_equivalence";
  package_proof_table: "web_lighthouse_package_proofs";
  runtime_table_columns: [
    "id",
    "provider",
    "command",
    "cwd",
    "executable",
    "hash_blake3",
    "claim_status",
    "equivalence_status",
  ];
  runtime_args_table_columns: ["runtime_id", "position", "arg"];
  equivalence_table_columns: [
    "runtime_id",
    "provider",
    "executable_hash_blake3",
    "status",
    "sample_count",
    "category_scores_match",
    "lhr_json_shape_match",
  ];
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
  ];
  required_runtime_args: ["js", "lighthouse"];
  required_provider: "dx-js";
  required_package_provider: "dx-build";
  required_package_name: "lighthouse";
  required_claim_status: "proven_bundle";
  required_equivalence_status: "verified";
  required_package_status: "verified";
  required_hash_algorithm: "blake3";
};

export type LighthousePackagingContract = {
  runtime_provider: "dx-js";
  build_provider: "dx-build";
  package_name: "lighthouse";
  packaged_command_status: "not_proven";
  package_assets_must_remain_filesystem_addressable: true;
  dynamic_imports_must_remain_runtime_compatible: true;
  node_builtins_must_remain_runtime_compatible: true;
  chrome_launcher_must_not_be_stubbed: true;
  equivalence_receipt_required: true;
  build_contract_command: "node ../build/packages/bench/receipt/lighthouse-package-contract.ts --contract --json";
  build_contract_package_script: "dx:lighthouse:package-contract";
  build_contract_package_script_command: "node ./packages/bench/receipt/lighthouse-package-contract.ts";
  build_contract_receipt_package_script: "receipt:lighthouse-package-contract";
  build_contract_receipt_package_script_command: "node ./receipt/lighthouse-package-contract.ts";
};

export type LighthouseContractRedaction = {
  metadata_only: true;
  stores_lhr_json: false;
  stores_traces: false;
  stores_screenshots: false;
  executes_chrome: false;
};

export type DxLighthouseRuntimeContractOptions = {
  repoRoot?: string;
  buildWorkspace?: string;
  fileExists?: (path: string) => boolean;
  directoryExists?: (path: string) => boolean;
  readText?: (path: string) => string | undefined;
};

export type DxLighthouseRuntimeContractArgs = { ok: true; mode: "contract_json" } | { ok: false; message: string };

const contractUsage = "bun --silent run dx:lighthouse:contract --contract --json";
const packageScript = "dx:lighthouse:contract";
const packageScriptCommand = "bun --silent ./scripts/dx-lighthouse-runtime-contract.ts";
const sourceScript = "scripts/dx-lighthouse-runtime-contract.ts";
const buildContractCommand = "node ../build/packages/bench/receipt/lighthouse-package-contract.ts --contract --json";
const buildContractPackageScript = "dx:lighthouse:package-contract";
const buildContractPackageScriptCommand = "node ./packages/bench/receipt/lighthouse-package-contract.ts";
const buildContractReceiptPackageScript = "receipt:lighthouse-package-contract";
const buildContractReceiptPackageScriptCommand = "node ./receipt/lighthouse-package-contract.ts";
const runtimeTableColumns: CheckRuntimeGate["runtime_table_columns"] = [
  "id",
  "provider",
  "command",
  "cwd",
  "executable",
  "hash_blake3",
  "claim_status",
  "equivalence_status",
];
const runtimeArgsTableColumns: CheckRuntimeGate["runtime_args_table_columns"] = [
  "runtime_id",
  "position",
  "arg",
];
const equivalenceTableColumns: CheckRuntimeGate["equivalence_table_columns"] = [
  "runtime_id",
  "provider",
  "executable_hash_blake3",
  "status",
  "sample_count",
  "category_scores_match",
  "lhr_json_shape_match",
];
const packageProofTableColumns: CheckRuntimeGate["package_proof_table_columns"] = [
  "runtime_id",
  "provider",
  "package_name",
  "status",
  "build_receipt_hash_blake3",
  "package_assets_filesystem_addressable",
  "dynamic_imports_runtime_compatible",
  "node_builtins_runtime_compatible",
  "chrome_launcher_unstubbed",
];
const requiredRuntimeArgs: CheckRuntimeGate["required_runtime_args"] = ["js", "lighthouse"];
const defaultRepoRoot = join(import.meta.dir, "..");
const defaultBuildWorkspace = join(defaultRepoRoot, "..", "build");

export function buildDxLighthouseRuntimeContract(
  options: DxLighthouseRuntimeContractOptions = {},
): DxLighthouseRuntimeContract {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const buildWorkspace = options.buildWorkspace ?? defaultBuildWorkspace;
  const fileExists = options.fileExists ?? isFile;
  const directoryExists = options.directoryExists ?? isDirectory;
  const readText = options.readText ?? readTextFile;
  const packageJson = join(repoRoot, "package.json");
  const contractScript = join(repoRoot, ...sourceScript.split("/"));
  const lighthousePackage = join(repoRoot, "node_modules", "lighthouse", "package.json");
  const buildPackageJson = join(buildWorkspace, "package.json");
  const buildBenchPackageJson = join(buildWorkspace, "packages", "bench", "package.json");
  const buildLighthouseContract = join(
    buildWorkspace,
    "packages",
    "bench",
    "receipt",
    "lighthouse-package-contract.ts",
  );
  const buildCli = join(buildWorkspace, "packages", "rolldown", "bin", "cli.mjs");
  const packageJsonPresent = fileExists(packageJson);
  const scriptAvailable = fileExists(contractScript);
  const packageScriptAvailable =
    scriptAvailable && packageJsonDeclaresScript(packageJson, packageScript, packageScriptCommand, readText);
  const dependencyAvailable = fileExists(lighthousePackage);

  return {
    schema_version: "dx.js.lighthouse_contract.v1",
    command: "dx js lighthouse --contract --json",
    package_script: packageScript,
    source_script: sourceScript,
    status: "not_ready",
    summary:
      "DX JS Lighthouse scoring is disabled until the runtime proves category-score and LHR JSON equivalence with official Google Lighthouse.",
    javascript_runtime: workspaceStatus("dx-js", repoRoot, directoryExists, fileExists, [
      packageJson,
      contractScript,
      lighthousePackage,
    ]),
    build_engine: workspaceStatus("dx-build", buildWorkspace, directoryExists, fileExists, [
      buildPackageJson,
      buildBenchPackageJson,
      buildLighthouseContract,
      buildCli,
    ]),
    availability: {
      available: false,
      script_available: scriptAvailable,
      dependency_available: dependencyAvailable,
      source_tracked_support_available: scriptAvailable,
      receipt_available: false,
      report_available: false,
      lighthouse_build_artifact_available: false,
      fresh_dx_js_package_receipt_available: false,
    },
    official_lighthouse: {
      npm_package: "lighthouse",
      package_present: dependencyAvailable,
      node_engine_required: true,
      chrome_headless_required: true,
      lhr_json_required: true,
    },
    execution_contract: {
      package_script_routing: packageScriptAvailable,
      requires_dx_js_package_json: packageJsonPresent,
      executes_lighthouse: false,
      executes_chrome: false,
      writes_receipts: false,
      writes_files: false,
    },
    scoring: {
      dx_js_scores_available: false,
      official_category_scores_required: true,
      score_equivalence_required: true,
      lhr_json_shape_equivalence_required: true,
      fake_scores_allowed: false,
    },
    check_runtime_gate: checkRuntimeGate(),
    packaging_contract: {
      runtime_provider: "dx-js",
      build_provider: "dx-build",
      package_name: "lighthouse",
      packaged_command_status: "not_proven",
      package_assets_must_remain_filesystem_addressable: true,
      dynamic_imports_must_remain_runtime_compatible: true,
      node_builtins_must_remain_runtime_compatible: true,
      chrome_launcher_must_not_be_stubbed: true,
      equivalence_receipt_required: true,
      build_contract_command: buildContractCommand,
      build_contract_package_script: buildContractPackageScript,
      build_contract_package_script_command: buildContractPackageScriptCommand,
      build_contract_receipt_package_script: buildContractReceiptPackageScript,
      build_contract_receipt_package_script_command: buildContractReceiptPackageScriptCommand,
    },
    next_actions: [
      "Install or vendor the official Lighthouse package only behind a stable DX JS runtime command.",
      "Run the official Lighthouse CLI and the DX JS command on the same URLs and compare category scores plus LHR JSON shape.",
      "Generate the Check runtime receipt only after the DX JS executable hash and equivalence proof are verified.",
    ],
    blockers: [
      "The official Lighthouse package is not part of the DX JS runtime contract yet.",
      "DX Build has not produced a verified Lighthouse package with filesystem assets, dynamic imports, Node built-ins, and Chrome launcher behavior intact.",
      "Check must keep using official Lighthouse execution or imported LHR JSON until the DX JS runtime receipt is verified.",
    ],
    redaction: {
      metadata_only: true,
      stores_lhr_json: false,
      stores_traces: false,
      stores_screenshots: false,
      executes_chrome: false,
    },
  };
}

export function parseDxLighthouseRuntimeContractArgs(args: string[]): DxLighthouseRuntimeContractArgs {
  if (args.length === 0) {
    return {
      ok: false,
      message: `DX JS Lighthouse scoring is not ready. Inspect \`${contractUsage}\` for metadata.`,
    };
  }

  let contractCount = 0;
  let jsonCount = 0;
  for (const arg of args) {
    if (arg === "--contract") {
      contractCount += 1;
    } else if (arg === "--json") {
      jsonCount += 1;
    } else {
      return {
        ok: false,
        message: `Unsupported DX JS Lighthouse contract argument \`${arg}\`; expected \`${contractUsage}\`.`,
      };
    }
  }

  if (contractCount !== 1) {
    return { ok: false, message: `${contractUsage} requires exactly one --contract flag.` };
  }
  if (jsonCount === 0) {
    return { ok: false, message: `${contractUsage} requires --json.` };
  }
  if (jsonCount > 1) {
    return { ok: false, message: `${contractUsage} requires exactly one --json flag.` };
  }

  return { ok: true, mode: "contract_json" };
}

function checkRuntimeGate(): CheckRuntimeGate {
  return {
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
    runtime_table_columns: runtimeTableColumns,
    runtime_args_table_columns: runtimeArgsTableColumns,
    equivalence_table_columns: equivalenceTableColumns,
    package_proof_table_columns: packageProofTableColumns,
    required_runtime_args: requiredRuntimeArgs,
    required_provider: "dx-js",
    required_package_provider: "dx-build",
    required_package_name: "lighthouse",
    required_claim_status: "proven_bundle",
    required_equivalence_status: "verified",
    required_package_status: "verified",
    required_hash_algorithm: "blake3",
  };
}

function workspaceStatus(
  id: string,
  workspace: string,
  directoryExists: (path: string) => boolean,
  fileExists: (path: string) => boolean,
  requiredFiles: string[],
): ToolchainWorkspaceStatus {
  return {
    id,
    path: displayPath(workspace),
    present: directoryExists(workspace),
    required_files: requiredFiles.map(path => ({
      path: displayRequiredFilePath(workspace, path),
      present: fileExists(path),
    })),
  };
}

function displayRequiredFilePath(workspace: string, path: string): string {
  const relativePath = relative(workspace, path);

  if (!relativePath.startsWith("..")) {
    return displayPath(relativePath || ".");
  }

  return displayPath(path);
}

function displayPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function packageJsonDeclaresScript(
  packageJson: string,
  scriptName: string,
  expectedCommand: string,
  readText: (path: string) => string | undefined,
): boolean {
  const text = readText(packageJson);
  if (text === undefined) {
    return false;
  }

  try {
    const value = JSON.parse(text);
    const script = value?.scripts?.[scriptName];
    return typeof script === "string" && script.trim() === expectedCommand;
  } catch {
    return false;
  }
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const parsed = parseDxLighthouseRuntimeContractArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exit(1);
  }

  console.log(JSON.stringify(buildDxLighthouseRuntimeContract(), null, 2));
}
