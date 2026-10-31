import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("ADR filenames use unique numeric prefixes", () => {
  const adrDir = path.join(repoRoot, "docs", "adr");
  const byNumber = new Map<string, string[]>();
  for (const name of fs.readdirSync(adrDir)) {
    const match = /^(\d{4})-.+\.md$/.exec(name);
    if (match === null) continue;
    const number = match[1]!;
    byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
  }
  const duplicates = [...byNumber]
    .filter(([, names]) => names.length > 1)
    .map(([number, names]) => `${number}: ${names.join(", ")}`);
  assert.deepEqual(duplicates, []);
});
