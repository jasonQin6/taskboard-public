/**
 * settings 键集合契约（晨析条目 5）：键清单的单一声明处在 types.ts 的 SETTINGS_KEYS（satisfies
 * 钉住与 Settings 接口一致）；settings.update 的可写键（actions 的 SETTINGS_UPDATE_KEYS）从全集
 * 显式减门键派生——automationLiveGate 只经 shadow.collect/shadow.label/automation.live.enter
 * 流转，settings.update 收它等于跳级（actions 门动作注释；行为面由 automation/http 测试钉住）。
 * 第二真值源 = DEFAULT_SETTINGS（store.ts）：每个合法键必须有默认值，多键少键在此变红。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS_UPDATE_KEYS } from "../src/actions.js";
import { DEFAULT_SETTINGS } from "../src/store/index.js";
import { SETTINGS_KEYS } from "../src/types.js";

test("settings 键集合：SETTINGS_KEYS 与 DEFAULT_SETTINGS 键一致且无重复", async () => {
  assert.deepEqual([...SETTINGS_KEYS].sort(), Object.keys(DEFAULT_SETTINGS).sort());
  assert.equal(new Set(SETTINGS_KEYS).size, SETTINGS_KEYS.length, "键集合不得重复");
});

test("settings SystemOne 四键默认值（issue #45 单元 3）", () => {
  assert.equal(DEFAULT_SETTINGS.systemoneEnabled, true);
  assert.equal(DEFAULT_SETTINGS.systemoneModel, null);
  assert.equal(DEFAULT_SETTINGS.systemoneDailyTokenBudget, 200_000);
  assert.equal(DEFAULT_SETTINGS.systemoneTokenEnv, null);
});

test("settings.update 可写键 = 全集 − 门键（automationLiveGate 不得经 update 跳级）", async () => {
  const gated = ["automationLiveGate"]; // 独立真值：门键清单（词汇表「自治上线门」）
  assert.deepEqual(
    [...SETTINGS_UPDATE_KEYS].sort(),
    [...SETTINGS_KEYS].filter((key) => !gated.includes(key)).sort(),
  );
});
