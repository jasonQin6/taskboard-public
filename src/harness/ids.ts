/**
 * 跨 Harness 身份字面量单源（叶子模块：零导入，store/reader 可安全引用，不形成分层反向）。
 * store 与 reader 只认传入值，不再拥有具体 harness 身份的默认值。
 */
export const CODEX_HARNESS_ID = "codex";
