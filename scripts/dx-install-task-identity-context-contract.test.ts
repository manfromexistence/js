import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, ...relativePath.split("/")), "utf8");
}

test("keeps install task-id maps on identity hash contexts", () => {
  const networkTask = readRepoFile("src/install/NetworkTask.rs");
  const packageManager = readRepoFile("src/install/PackageManager.rs");
  const packageManagerTask = readRepoFile("src/install/PackageManagerTask.rs");

  expect(packageManagerTask).toContain("impl bun_collections::IdentityHash for Id");
  expect(packageManager).toContain("HashMap<Task::Id, TaskCallbackList, IdentityContext<Task::Id>>");
  expect(packageManager).toContain("type RepositoryMap = HashMap<Task::Id, Fd, IdentityContext<Task::Id>>;");

  expect(networkTask).toContain("use bun_collections::{HashMap, IdentityContext};");
  expect(networkTask).toContain("pub(crate) type DedupeMap = HashMap<");
  expect(networkTask).toContain("crate::package_manager_task::Id,");
  expect(networkTask).toContain("DedupeMapEntry,");
  expect(networkTask).toContain("IdentityContext<crate::package_manager_task::Id>,");
  expect(networkTask).not.toContain("TODO(port): IdentityContext");
});
