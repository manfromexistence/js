import { expect, test } from "bun:test";
import { getStaticExports, parseOxcShadow } from "./oxc-shadow.ts";

test("extracts static exports from TypeScript route modules", () => {
  const result = parseOxcShadow(
    "remix-route.ts",
    `
      import type { LoaderFunction } from "remix";
      export const loader: LoaderFunction = async () => {};
      export const action = async () => {};
      export default function Route() { return null; }
    `,
  );

  expect(result.errors).toEqual([]);
  expect(getStaticExports(result.module)).toEqual(["action", "default", "loader"]);
});

test("parses TSX, JSX, JS, and TS source kinds without replacing Bun parser", () => {
  const cases = [
    ["component.tsx", "export default function View() { return <div />; }"],
    ["component.jsx", "export default function View() { return <div />; }"],
    ["plain.js", "export const value = 1;"],
    ["plain.ts", "export const value: number = 1;"],
  ] as const;

  for (const [fileName, source] of cases) {
    const result = parseOxcShadow(fileName, source);
    expect(result.errors).toEqual([]);
    expect(getStaticExports(result.module).length).toBeGreaterThan(0);
  }
});
