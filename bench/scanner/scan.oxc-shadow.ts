import { readFileSync } from "node:fs";
import { getStaticExports, parseOxcShadow } from "./oxc-shadow.ts";

const expectedExports = ["action", "default", "loader"];
const iterations = Number.parseInt(process.env.ITERATIONS || "1", 10) || 1;
const fileName = "remix-route.ts";
const file = readFileSync(fileName, "utf8");

console.time("Get exports");

for (let i = 0; i < iterations; i++) {
  const result = parseOxcShadow(fileName, file);

  if (result.errors.length) {
    throw new Error(result.errors.map((error) => error.message).join("\n"));
  }

  const exports = getStaticExports(result.module);
  for (let j = 0; j < expectedExports.length; j++) {
    if (expectedExports[j] !== exports[j]) {
      throw new Error(`Mismatch: expected ${expectedExports.join(",")} but received ${exports.join(",")}`);
    }
  }
}

console.timeEnd("Get exports");
