import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localBun = join(root, "build", "release", "bun.exe");
const fixture = join(root, ".tmp", "dx-printer-number-format-contract");

function runLocalBun(args: string[]) {
  const result = spawnSync(localBun, args, {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

test("JS printer number helper keeps integers on itoa and non-integers on ryu", () => {
  const source = readFileSync(join(root, "src", "js_printer", "lib.rs"), "utf8");
  const workspaceCargo = readFileSync(join(root, "Cargo.toml"), "utf8");
  const printerCargo = readFileSync(join(root, "src", "js_printer", "Cargo.toml"), "utf8");

  expect(workspaceCargo).toContain("itoa = \"1\"");
  expect(workspaceCargo).toContain("ryu = \"1\"");
  expect(printerCargo).toContain("ryu.workspace = true");
  expect(source).toContain("fn print_non_negative_float_to(mut print: impl FnMut(&[u8]), float: f64)");
  expect(source).toContain("let is_integer = remainder == 0.0;");
  expect(source).toContain("float < (u64::MAX >> 12) as f64");
  expect(source).toContain("let val = float as u64;");
  expect(source).toContain("bun_core::fmt::pow10_exp_1e4_to_1e9(val)");
  expect(source).toContain("let mut buf = bun_core::fmt::ItoaBuf::new();");
  expect(source).toContain("bun_core::fmt::itoa(&mut buf, val)");
  expect(source).toContain("let mut buf = ryu::Buffer::new();");
  expect(source).toContain("buf.format_finite(float).as_bytes()");
  expect(source).toContain('self.print(b"NaN");');
  expect(source).toContain('self.print(b"Infinity");');
  expect(source).toContain('self.print(b"1/0");');
  expect(source).toContain("non_negative_integer_output_stays_on_itoa_path");
  expect(source).toContain("non_integer_float_output_uses_short_round_trip_decimal");

  const helper = source.slice(
    source.indexOf("fn print_non_negative_float_to"),
    source.indexOf("/// `fn NewPrinter"),
  );
  expect(helper.indexOf("bun_core::fmt::itoa")).toBeLessThan(helper.indexOf("ryu::Buffer::new"));
});

test("local release minifier keeps compact integer and float output stable", () => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });

  const entry = join(fixture, "entry.ts");
  writeFileSync(
    entry,
    'export const values = [0, -0, 42, 10000, 1000000000, 10000000000, 9007199254740991, 9007199254740992, 0.1, 1.2345, 1.7976931348623157e308, 5e-324, NaN, Infinity, -Infinity]; console.log(values.join(","));\n',
  );

  const entryForBun = entry.replaceAll("\\", "/");
  const script = `
const result = await Bun.build({ entrypoints: [${JSON.stringify(entryForBun)}], minify: true, write: false });
if (!result.success) {
  console.error(result.logs.map((log) => String(log)).join("\\n"));
  process.exit(1);
}
console.log(await result.outputs[0].text());
`;
  const result = runLocalBun(["-e", script]);

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(
    "[0,-0,42,1e4,1e9,10000000000,9007199254740991.0,9007199254740992.0,0.1,1.2345,1.7976931348623157e308,5e-324,NaN,1/0,-1/0]",
  );
});
