/**
 * 钉住 cron 5 段解析与下一次触发时间的语义。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRunAfter, parseCron } from "../src/cron.js";

test("parseCron rejects malformed expressions", () => {
  assert.throws(() => parseCron("* * *")); // 段数不足
  assert.throws(() => parseCron("61 * * * *")); // 分钟越界
  assert.throws(() => parseCron("a * * * *")); // 非数字
  assert.throws(() => parseCron("* * 0 * *")); // 日从 1 起
  assert.throws(() => parseCron("* * * 13 *")); // 月越界
  assert.throws(() => parseCron("*/0 * * * *")); // step 0
  assert.throws(() => parseCron("5-2 * * * *")); // 倒序区间
  assert.throws(() => parseCron("*-* * * * *")); // * 带区间
});

test("parseCron normalizes dow 7 to 0", () => {
  const fields = parseCron("0 0 * * 7");
  assert.equal(fields.daysOfWeek.has(0), true);
  assert.equal(fields.daysOfWeek.has(7), false);
});

test("nextRunAfter */15 fires at next quarter boundary", () => {
  const from = new Date(2026, 9, 10, 10, 7, 30);
  const next = nextRunAfter("*/15 * * * *", from);
  assert.deepEqual([next.getHours(), next.getMinutes(), next.getSeconds()], [10, 15, 0]);
});

test("nextRunAfter daily at 09:30 rolls to tomorrow when past", () => {
  const from = new Date(2026, 9, 10, 12, 0);
  const next = nextRunAfter("30 9 * * *", from);
  assert.deepEqual([next.getDate(), next.getHours(), next.getMinutes()], [11, 9, 30]);
});

test("nextRunAfter is strictly after `from` (same minute excluded)", () => {
  const from = new Date(2026, 9, 10, 10, 15, 0);
  const next = nextRunAfter("*/15 * * * *", from);
  assert.deepEqual([next.getHours(), next.getMinutes()], [10, 30]);
});

test("nextRunAfter day-of-week matches next occurrence", () => {
  // 2026-10-10 是周六；表达式「周一 12:00」→ 10-12。
  const from = new Date(2026, 9, 10, 12, 0);
  const next = nextRunAfter("0 12 * * 1", from);
  assert.equal(next.getDay(), 1);
  assert.deepEqual([next.getDate(), next.getHours(), next.getMinutes()], [12, 12, 0]);
});

test("nextRunAfter dom/dow union follows vixie OR semantics", () => {
  // 「1 1 13 * 5」= 每月 13 号或周五 01:01；2026-10-10(周六) 02:00 之后第一个匹配是 10-13(周二，dom)。
  const from = new Date(2026, 9, 10, 2, 0);
  const next = nextRunAfter("1 1 13 * 5", from);
  assert.deepEqual(
    [next.getMonth() + 1, next.getDate(), next.getHours(), next.getMinutes()],
    [10, 13, 1, 1],
  );
});

test("nextRunAfter range with step", () => {
  const from = new Date(2026, 9, 10, 10, 7, 0);
  const next = nextRunAfter("10-40/15 * * * *", from);
  assert.equal(next.getMinutes(), 10); // {10,25,40} 中 >07 的第一个是 10
  assert.equal(next.getHours(), 10);
});
