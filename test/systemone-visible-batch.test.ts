/**
 * 跨端 visible 批上限契约（#45 open item）：服务端 MAX_SYSTEMONE_VISIBLE（actions.ts）与
 * web SYSTEMONE_VISIBLE_BATCH（board-model.ts）是两处独立硬编码，漂移会让整批 visible
 * 请求 400。单源下发（runtime view）是后续行为改动；在那之前由本测试钉住两值相等。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SYSTEMONE_VISIBLE } from "../src/actions.js";
import { SYSTEMONE_VISIBLE_BATCH } from "../web/src/lib/board-model.js";

test("web visible 批上限与服务端 MAX_SYSTEMONE_VISIBLE 相等（漂移即红）", () => {
  assert.ok(Number.isInteger(MAX_SYSTEMONE_VISIBLE) && MAX_SYSTEMONE_VISIBLE > 0);
  assert.equal(SYSTEMONE_VISIBLE_BATCH, MAX_SYSTEMONE_VISIBLE);
});
