/**
 * SettingsStore：settings 域（晨析 10-25 自 core.ts 外挪的第五族）——getSettings 只读、
 * updateSettings 经 StoreCore 事务缝（core.write + touch("config")）落库。merge/validate 提为
 * 模块级纯函数（可直测）；automation-store 在外层事务内嵌套调 updateSettings 依赖 core.write 的
 * active 复用（ADR-0016 承重墙，直测见 store.test.ts #37）。
 */

import type { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors.js";
import { AUTOMATION_GATE_MODES, type Settings } from "../types.js";
import { StoreCore } from "./core.js";

export const DEFAULT_SETTINGS: Settings = {
  automationPaused: false,
  idleThresholdMs: 600_000,
  concurrencyLimit: 2,
  preventIdleSleep: false,
  maxSubtaskDepth: 1,
  retention: { runsPerTask: 20, unboundEvidenceDays: 90, boundEvidenceDays: 90 },
  jevModel: null,
  jevEffort: null,
  sampleEnabled: false,
  trustedProxyHosts: [],
  proxyTokenEnv: null,
  worktreeBaseBranch: null,
  systemoneEnabled: true,
  systemoneModel: null,
  systemoneDailyTokenBudget: 200_000,
  systemoneTokenEnv: null,
  automationLiveGate: "shadow",
};

/** 库内存储与默认值的合并：retention 子对象按字段并集（库内只存补丁），未知键丢弃不透传。 */
export const mergeSettings = (base: Settings, stored: Record<string, unknown>): Settings => {
  const merged: Settings = { ...base, retention: { ...base.retention } };
  for (const [key, value] of Object.entries(stored)) {
    switch (key) {
      case "retention":
        merged.retention = { ...base.retention, ...(value as object) };
        break;
      case "idleThresholdMs":
      case "concurrencyLimit":
      case "maxSubtaskDepth":
        merged[key] = value as number;
        break;
      case "jevModel":
      case "jevEffort":
        merged[key] = value as string | null;
        break;
      case "trustedProxyHosts":
        merged[key] = value as string[];
        break;
      case "proxyTokenEnv":
      case "systemoneModel":
      case "systemoneTokenEnv":
        merged[key] = value as string | null;
        break;
      default:
        if (key in base && key !== "retention") {
          (merged as Record<keyof Settings, unknown>)[key as keyof Settings] = value;
        }
    }
  }
  return merged;
};

/** 逐键类型/值域校验：未知键一律拒绝（新键必须先进 Settings 与 SETTINGS_KEYS 才可写）。 */
export const validateSettingsPatch = (patch: Partial<Settings>): void => {
  const positiveInt = (key: string, value: unknown): void => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new ValidationError(`${key} must be a positive integer`);
    }
  };
  const nonNegativeInt = (key: string, value: unknown): void => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new ValidationError(`${key} must be a non-negative integer`);
    }
  };
  const stringOrNull = (key: string, value: unknown): void => {
    if (value !== null && typeof value !== "string") {
      throw new ValidationError(`${key} must be a string or null`);
    }
  };
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "automationPaused":
      case "preventIdleSleep":
      case "sampleEnabled":
      case "systemoneEnabled":
        if (typeof value !== "boolean") throw new ValidationError(`${key} must be a boolean`);
        break;
      case "idleThresholdMs":
      case "concurrencyLimit":
        positiveInt(key, value);
        break;
      case "systemoneDailyTokenBudget":
        nonNegativeInt(key, value);
        break;
      case "maxSubtaskDepth":
        positiveInt(key, value);
        if ((value as number) < 1 || (value as number) > 3) {
          throw new ValidationError("maxSubtaskDepth must be between 1 and 3");
        }
        break;
      case "retention":
        for (const [subKey, subValue] of Object.entries(value as object)) {
          positiveInt(`retention.${subKey}`, subValue);
        }
        break;
      case "jevModel":
      case "jevEffort":
      case "proxyTokenEnv":
        stringOrNull(key, value);
        break;
      case "systemoneModel":
      case "systemoneTokenEnv":
        stringOrNull(key, value);
        if (typeof value === "string" && value.trim().length === 0) {
          throw new ValidationError(`${key} must be a non-empty string or null`);
        }
        break;
      case "worktreeBaseBranch":
        if (value !== null && (typeof value !== "string" || value.trim().length === 0)) {
          throw new ValidationError("worktreeBaseBranch must be a non-empty string or null");
        }
        break;
      case "automationLiveGate":
        // 词汇单源：与 types.ts AUTOMATION_GATE_MODES 派生，加模式只改数组（同 SHADOW_LABELS 的用法）
        if (!(AUTOMATION_GATE_MODES as readonly string[]).includes(value as string)) {
          throw new ValidationError(`automationLiveGate must be one of: ${AUTOMATION_GATE_MODES.join(", ")}`);
        }
        break;
      case "trustedProxyHosts":
        if (
          !Array.isArray(value) ||
          value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
        ) {
          throw new ValidationError("trustedProxyHosts must be an array of non-empty strings");
        }
        break;
      default:
        throw new ValidationError(`unknown settings key: ${key}`);
    }
  }
};

export class SettingsStore {
  private readonly core: StoreCore;
  private readonly db: DatabaseSync;

  constructor(core: StoreCore) {
    this.core = core;
    this.db = core.db;
  }

  getSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{
      key: string;
      value: string;
    }>;
    const stored: Record<string, unknown> = {};
    for (const row of rows) stored[row.key] = JSON.parse(row.value);
    return mergeSettings(DEFAULT_SETTINGS, stored);
  }

  updateSettings(patch: Partial<Settings>): Settings {
    validateSettingsPatch(patch);
    return this.core.write((touch) => {
      const upsert = this.db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      );
      for (const [key, value] of Object.entries(patch)) {
        upsert.run(key, JSON.stringify(value), this.core.now());
      }
      touch("config");
      return this.getSettings();
    });
  }
}
