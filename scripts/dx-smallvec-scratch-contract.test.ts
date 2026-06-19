import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, ...relativePath.split("/")), "utf8");
}

test("keeps install and proxy scratch paths on stack-backed SmallVec buffers", () => {
  const isolatedInstall = readRepoFile("src/install/isolated_install.rs");
  const asyncHttp = readRepoFile("src/http/AsyncHTTP.rs");

  expect(isolatedInstall).toContain("let mut dep_ids_sort_buf: SmallVec<[DependencyID; 16]>");
  expect(isolatedInstall).toContain("Vec<SmallVec<[PackageID; 4]>>");
  expect(isolatedInstall).toContain("let mut peer_dep_ids: SmallVec<[DependencyID; 8]>");
  expect(isolatedInstall).toContain("let mut visited_parent_node_ids: SmallVec<[store::node::Id; 16]>");
  expect(isolatedInstall).toContain("let dedupe_peers: SmallVec<[store::node::TransitivePeer; 4]>");

  expect(asyncHttp).toContain("use bun_collections::smallvec::SmallVec;");
  expect(asyncHttp).toContain("fn build_proxy_authorization(proxy: &URL<'_>) -> Option<Vec<u8>>");
  expect(asyncHttp).toContain("let auth: SmallVec<[u8; 512]>");
  expect(asyncHttp).toContain("SmallVec::with_capacity(username.len() + 1 + password.len())");
  expect(asyncHttp).toContain("fn decode_proxy_auth_part(input: &[u8]) -> Result<SmallVec<[u8; 256]>");
  expect(asyncHttp).toContain("let mut output = SmallVec::<[u8; 256]>::new();");
});
