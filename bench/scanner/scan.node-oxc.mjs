import { parseSync } from "oxc-parser";
import { readFileSync } from "fs";

const fixture = ["action", "default", "loader"];
const ITERATIONS = parseInt(process.env.ITERATIONS || "1") || 1;
const file = readFileSync("remix-route.ts", "utf8");

function getExports(module) {
  const exports = [];

  for (const statement of module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.exportName.kind === "Default") {
        exports.push("default");
      } else if (entry.exportName.name) {
        exports.push(entry.exportName.name);
      }
    }
  }

  exports.sort();

  for (let i = 0; i < fixture.length; i++) {
    if (fixture[i] !== exports[i]) {
      throw new Error("Mismatch");
    }
  }
}

console.time("Get exports");

for (let i = 0; i < ITERATIONS; i++) {
  const result = parseSync("remix-route.ts", file, {
    lang: "ts",
    sourceType: "module",
  });

  if (result.errors.length) {
    throw new Error(result.errors.map(error => error.message).join("\n"));
  }

  getExports(result.module);
}

console.timeEnd("Get exports");
