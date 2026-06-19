import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url);

function readRepoFile(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

function listRepoFiles(path: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(new URL(`${path}/`, root), { withFileTypes: true })) {
    const childPath = `${path}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listRepoFiles(childPath, extension));
    } else if (entry.isFile() && childPath.endsWith(extension)) {
      files.push(childPath);
    }
  }
  return files.sort();
}

test("thread pools keep stack bounds unless the audited package-manager pools opt out", () => {
  const threadPool = readRepoFile("src/threading/ThreadPool.rs");
  const packageManager = readRepoFile("src/install/PackageManager.rs");
  const workPool = readRepoFile("src/threading/work_pool.rs");

  expect(threadPool).toContain("pub needs_stack_bounds: bool");
  expect(threadPool).toContain("needs_stack_bounds: true");
  expect(threadPool).toContain("if thread_pool.get().needs_stack_bounds");

  const falseAssignments = [...packageManager.matchAll(/pool\.needs_stack_bounds\s*=\s*false;/g)];
  expect(falseAssignments).toHaveLength(2);

  const falseAssignmentPattern = /(?:^|\n)\s*\w+\.needs_stack_bounds\s*=\s*false;/g;
  const sourceFilesWithFalseOptOuts = listRepoFiles("src", ".rs").flatMap((path) => {
    const matches = [...readRepoFile(path).matchAll(falseAssignmentPattern)];
    return matches.map(() => path);
  });

  expect(sourceFilesWithFalseOptOuts).toEqual([
    "src/install/PackageManager.rs",
    "src/install/PackageManager.rs",
  ]);
  expect(workPool).toContain("ThreadPool::init(crate::thread_pool::Config");
  expect(workPool).not.toContain("needs_stack_bounds = false");
});

test("stack-bounds audit in PLAN stays aligned with current source", () => {
  const plan = readRepoFile("PLAN.md");
  const packageManagerPath = join("src", "install", "PackageManager.rs");

  expect(plan).toContain("only pools that never execute JS/JSC callbacks may set `needs_stack_bounds = false`");
  expect(plan).toContain(packageManagerPath.replaceAll("\\", "/"));
  expect(plan).toContain("shared/bundler JS-capable pools keep stack bounds");
});
