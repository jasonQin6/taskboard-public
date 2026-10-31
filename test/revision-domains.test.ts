/**
 * 域 revision 集合契约（词汇表「域 revision」）：后端唯一声明处 = REVISION_DOMAINS（src/types.ts），
 * store 的 TouchedDomains 键型与 bumpRevisions 循环从它派生。spec 字面量来自词汇表，独立于常量，
 * 两侧漂移（有人改常量漏改词汇表，或反之）在此变红。tool-contract 另从 status 载荷侧钉住同集合。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { REVISION_DOMAINS } from "../src/types.js";
import { REVISION_DOMAINS as WEB_REVISION_DOMAINS } from "../web/src/lib/endpoints.js";

// 独立真值：GLOSSARY「域 revision（domain revision）：按 tasks、threads、config 分域维护的单调写序号」
const SPEC = ["config", "tasks", "threads"];

test("revision 域集合：REVISION_DOMAINS 与词汇表 spec 一致且无重复", async () => {
  assert.deepEqual([...REVISION_DOMAINS].sort(), SPEC);
  assert.equal(new Set(REVISION_DOMAINS).size, SPEC.length, "域集合不得有重复项");
});

test("revision 域集合：web 副本（endpoints.ts）与后端常量一致——两端漂移在此变红", async () => {
  assert.deepEqual([...WEB_REVISION_DOMAINS].sort(), [...REVISION_DOMAINS].sort());
});
