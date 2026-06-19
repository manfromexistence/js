import {
  parseSync,
  type EcmaScriptModule,
  type ParserOptions,
  type ParseResult,
} from "oxc-parser";

export type OxcShadowLang = NonNullable<ParserOptions["lang"]>;

export function langForFileName(fileName: string): OxcShadowLang {
  const lower = fileName.toLowerCase();

  if (lower.endsWith(".tsx")) {
    return "tsx";
  }
  if (lower.endsWith(".jsx")) {
    return "jsx";
  }
  if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) {
    return "dts";
  }
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return "ts";
  }

  return "js";
}

export function parseOxcShadow(fileName: string, source: string): ParseResult {
  return parseSync(fileName, source, {
    lang: langForFileName(fileName),
    sourceType: "module",
  });
}

export function getStaticExports(module: EcmaScriptModule): string[] {
  const exports: string[] = [];

  for (const statement of module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.isType) {
        continue;
      }

      if (entry.exportName.kind === "Default") {
        exports.push("default");
      } else if (entry.exportName.name) {
        exports.push(entry.exportName.name);
      }
    }
  }

  return exports.sort();
}
