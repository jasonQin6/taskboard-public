/**
 * 钉住 cron 的 IANA 时区与夏令时边界语义。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidTimeZone, nextRunAfterInTz, validateTimeZone } from "../src/cron.js";

/**
 * IANA 时区 cron 的 next 求解（Intl 投影）。用例日期全部钉在真实 DST 边界：
 * - America/New_York 2026：spring-forward 2026-03-08（02:00 EST → 03:00 EDT，UTC 07:00 跳变，
 *   墙钟 02:00–02:59 不存在）；fall-back 2026-11-01（02:00 EDT → 01:00 EST，UTC 06:00 跳变，
 *   墙钟 01:00–01:59 出现两次：05:30Z 与 06:30Z 各一次）。
 * - Australia/Sydney 2026：fall-back 2026-04-05（03:00 AEDT → 02:00 AEST，UTC 04-04T16:00 跳变，
 *   墙钟 02:00–02:59 出现两次：04-04T15:30Z（AEDT，UTC+11）与 04-04T16:30Z（AEST，UTC+10））。
 *   东半球正偏移量时区专门钉「最早一次出现」——单次 guess-adjust 的 naive 反解在正偏移量
 *   时区会落到第二次出现，这里做回归哨兵。
 */

const utc = (iso: string): string => new Date(iso).toISOString();

test("isValidTimeZone / validateTimeZone probe via Intl", () => {
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("Not/AZone"), false);
  assert.equal(isValidTimeZone(""), false);

  assert.equal(validateTimeZone(" Asia/Shanghai "), "Asia/Shanghai"); // trim 后合法
  assert.throws(() => validateTimeZone("Not/AZone"));
  assert.throws(() => validateTimeZone(""));
  assert.throws(() => validateTimeZone(42));
  assert.throws(() => validateTimeZone(undefined));
});

test("daily cron in Asia/Shanghai rolls to the next local 09:30", () => {
  // from = 2026-10-12T00:00Z = 周一 08:00 CST：当天 09:30（01:30Z）尚未到 → 当天即命中。
  const next = nextRunAfterInTz("30 9 * * *", new Date("2026-10-12T00:00:00Z"), "Asia/Shanghai");
  assert.equal(next.toISOString(), utc("2026-10-12T01:30:00Z"));

  // 已过当天 09:30 → 明天 09:30 CST。
  const rolled = nextRunAfterInTz("30 9 * * *", new Date("2026-10-12T02:00:00Z"), "Asia/Shanghai");
  assert.equal(rolled.toISOString(), utc("2026-10-13T01:30:00Z"));
});

test("same cron in America/New_York follows the New York wall clock", () => {
  // from = 2026-10-12T00:00Z = 周日 20:00 EDT：下一个周一 09:30 EDT = 13:30Z。
  const next = nextRunAfterInTz("30 9 * * *", new Date("2026-10-12T00:00:00Z"), "America/New_York");
  assert.equal(next.toISOString(), utc("2026-10-12T13:30:00Z"));
});

test("day-of-week field interprets in the target zone", () => {
  // 周一 12:00 CST；from = 周五 2026-10-09T12:00Z（周五 20:00 CST）→ 下周一 12:00 CST = 04:00Z。
  const next = nextRunAfterInTz("0 12 * * 1", new Date("2026-10-09T12:00:00Z"), "Asia/Shanghai");
  assert.equal(next.toISOString(), utc("2026-10-12T04:00:00Z"));
});

test("dom/dow vixie OR union works through the tz solver", () => {
  // 「1 1 13 * 5」= 每月 13 号或周五 01:01；from = 2026-10-10T02:00Z（周六 10:00 CST）
  // → 10-13（周二，dom 命中）01:01 CST = 2026-10-12T17:01Z。
  const next = nextRunAfterInTz("1 1 13 * 5", new Date("2026-10-10T02:00:00Z"), "Asia/Shanghai");
  assert.equal(next.toISOString(), utc("2026-10-12T17:01:00Z"));
});

// ---- spring-forward：不存在的本地时间（不早触发、不漏触发）----

test("spring-forward: cron inside the gap fires at the transition end", () => {
  // 2026-03-08 02:30 EST 不存在（空档 02:00→03:00）：在拨快边界（03:00 EDT = 07:00Z）触发。
  const from = new Date("2026-03-07T17:00:00Z"); // 周六 12:00 EST
  const next = nextRunAfterInTz("30 2 * * *", from, "America/New_York");
  assert.equal(next.toISOString(), utc("2026-03-08T07:00:00Z"));
});

test("spring-forward: gap start (02:00) equally lands on the transition end", () => {
  const from = new Date("2026-03-07T17:00:00Z");
  const next = nextRunAfterInTz("0 2 * * *", from, "America/New_York");
  assert.equal(next.toISOString(), utc("2026-03-08T07:00:00Z"));
});

test("spring-forward: wall times before the gap are untouched", () => {
  // 01:59 EST 仍存在 = 06:59Z，不受拨快影响。
  const from = new Date("2026-03-07T17:00:00Z");
  const next = nextRunAfterInTz("59 1 * * *", from, "America/New_York");
  assert.equal(next.toISOString(), utc("2026-03-08T06:59:00Z"));
});

test("spring-forward: day after the transition behaves normally", () => {
  // 03-09 的 02:30 EDT = 06:30Z 正常存在。
  const next = nextRunAfterInTz("30 2 * * *", new Date("2026-03-09T00:00:00Z"), "America/New_York");
  assert.equal(next.toISOString(), utc("2026-03-09T06:30:00Z"));
});

test("spring-forward: firing at the transition end does not double-fire on re-arm", () => {
  // 在拨快边界触发后重武装：同一天的空档候选已越过 notBefore → 次日正常 02:30。
  const next = nextRunAfterInTz("30 2 * * *", new Date("2026-03-08T07:00:00Z"), "America/New_York");
  assert.equal(next.toISOString(), utc("2026-03-09T06:30:00Z"));
});

// ---- fall-back：重复的一小时（不早触发、不漏触发）----

test("fall-back: repeated wall time fires at the first occurrence", () => {
  // 01:30 出现两次（05:30Z EDT 与 06:30Z EST）：冷求解取最早一次。
  const from = new Date("2026-10-31T16:00:00Z"); // 周五 12:00 EDT
  const next = nextRunAfterInTz("30 1 * * *", from, "America/New_York");
  assert.equal(next.toISOString(), utc("2026-11-01T05:30:00Z"));
});

test("fall-back: re-arming after the first occurrence matches the second (vixie parity)", () => {
  // 第一次出现触发后从 now 重武装：严格大于 from 的最早匹配 = 第二次出现（vixie cron 同语义）。
  const next = nextRunAfterInTz("30 1 * * *", new Date("2026-11-01T05:30:00Z"), "America/New_York");
  assert.equal(next.toISOString(), utc("2026-11-01T06:30:00Z"));
});

test("fall-back: after both occurrences rolls to the next day", () => {
  const next = nextRunAfterInTz("30 1 * * *", new Date("2026-11-01T06:30:00Z"), "America/New_York");
  // 次日 01:30 EST = 06:30Z。
  assert.equal(next.toISOString(), utc("2026-11-02T06:30:00Z"));
});

test("fall-back in a positive-offset zone still picks the earliest occurrence", () => {
  // Sydney 2026-04-05 03:00 AEDT → 02:00 AEST：歧义墙钟 02:30 先后出现在 04-04T15:30Z（+11）
  // 与 04-04T16:30Z（+10）。正偏移量下 naive 单次反解会错拿第二次，这里钉最早一次。
  // 过渡日前一天（悉尼时间 04-03）的 02:30 无歧义，先钉普通路径。
  const before = nextRunAfterInTz("30 2 * * *", new Date("2026-04-02T00:00:00Z"), "Australia/Sydney");
  assert.equal(before.toISOString(), utc("2026-04-02T15:30:00Z")); // 04-03 02:30 AEDT

  // 已过无歧义那次（15:30Z）→ 下一个墙钟 02:30 是过渡日的歧义时刻，取最早一次。
  const from = new Date("2026-04-03T16:00:00Z");
  const next = nextRunAfterInTz("30 2 * * *", from, "Australia/Sydney");
  assert.equal(next.toISOString(), utc("2026-04-04T15:30:00Z"));

  // 首次出现触发后重武装 → 第二次出现（16:30Z）。
  const rearm = nextRunAfterInTz("30 2 * * *", new Date("2026-04-04T15:30:00Z"), "Australia/Sydney");
  assert.equal(rearm.toISOString(), utc("2026-04-04T16:30:00Z"));
});

// ---- 求解器边界 ----

test("never-firing expression throws within the one-year window (tz path)", () => {
  assert.throws(() =>
    nextRunAfterInTz("0 0 31 2 *", new Date("2026-01-01T00:00:00Z"), "Asia/Shanghai"),
  );
});

test("unknown time zone is rejected at solve time", () => {
  assert.throws(() =>
    nextRunAfterInTz("*/5 * * * *", new Date("2026-01-01T00:00:00Z"), "Not/AZone"),
  );
});
