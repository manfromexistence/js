import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const cargoToml = readFileSync(join(repoRoot, "Cargo.toml"), "utf8");
const profilesSource = readFileSync(join(repoRoot, "scripts", "build", "profiles.ts"), "utf8");
const rustBuildSource = readFileSync(join(repoRoot, "scripts", "build", "rust.ts"), "utf8");

test("native no-LTO release builds override Cargo fat-LTO defaults", () => {
  expect(profilesSource).toContain("release: {");
  expect(profilesSource).toContain("lto: false");
  expect(cargoToml).toContain("[profile.release]");
  expect(cargoToml).toContain('lto = "fat"');
  expect(cargoToml).toContain("codegen-units = 1");

  expect(rustBuildSource).toContain("const releaseWithoutCrossLanguageLto = cfg.release && !cfg.lto && !cfg.asan;");
  expect(rustBuildSource).toContain("env.CARGO_PROFILE_RELEASE_LTO = \"off\";");
  expect(rustBuildSource).toContain("const DEFAULT_RELEASE_CODEGEN_UNITS = \"16\";");
  expect(rustBuildSource).toContain("const RELEASE_CODEGEN_UNITS_ENV = \"BUN_DX_RELEASE_CODEGEN_UNITS\";");
  expect(rustBuildSource).toContain("env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS = releaseCodegenUnitsForNoLtoBuild();");
  expect(rustBuildSource).toContain("release profile must not accidentally inherit Cargo.toml");
});
