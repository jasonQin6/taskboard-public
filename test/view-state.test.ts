/**
 * 视图状态本地持久化（浏览器本地，绝不写数据库）。
 * 钉住沙箱场景：读 localStorage getter 本身抛 SecurityError 时不得炸调用方（useState 初始化器），
 * 必须回退 DEFAULT_VIEW_STATE——默认值求值必须发生在 try 之内。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_VIEW_STATE, loadViewState, saveViewState } from "../web/src/view-state.js";

const denyStorageAccess = (): void => {
  Object.defineProperty(globalThis, "localStorage", {
    get() {
      throw new Error("SecurityError: The document is sandboxed and lacks the allow-same-origin flag");
    },
    configurable: true,
  });
};

const restoreStorage = (previous: PropertyDescriptor | undefined): void => {
  if (previous === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Object.defineProperty(globalThis, "localStorage", previous);
};

test("view state: reading a throwing localStorage getter falls back to defaults instead of crashing", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  denyStorageAccess();
  try {
    let view: ReturnType<typeof loadViewState> | undefined;
    let saveThrew: unknown;
    assert.doesNotThrow(() => {
      view = loadViewState();
      try {
        saveViewState(DEFAULT_VIEW_STATE);
      } catch (error) {
        saveThrew = error;
      }
    });
    assert.deepEqual(view, DEFAULT_VIEW_STATE);
    assert.equal(saveThrew, undefined);
  } finally {
    restoreStorage(previous);
  }
});

test("view state: explicit storage still round-trips and malformed payloads fall back", () => {
  const backing = new Map<string, string>();
  const store = {
    getItem: (key: string): string | null => backing.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      backing.set(key, value);
    },
  };
  saveViewState({ query: "登录", workspace: "/repo/beta", compact: true, archivedVisible: true }, store);
  assert.deepEqual(loadViewState(store), {
    query: "登录",
    workspace: "/repo/beta",
    compact: true,
    archivedVisible: true,
  });
  backing.set("taskboard.view.v1", "{not json");
  assert.deepEqual(loadViewState(store), DEFAULT_VIEW_STATE);
});
