/** 视图状态（搜索词、workspace 过滤、紧凑模式、归档折叠展开）只存浏览器本地，绝不写数据库。 */

export interface ViewState {
  query: string;
  /** 空串 = 全部 workspace。 */
  workspace: string;
  compact: boolean;
  archivedVisible: boolean;
}

export const DEFAULT_VIEW_STATE: ViewState = {
  query: "",
  workspace: "",
  compact: false,
  archivedVisible: false,
};

const STORAGE_KEY = "taskboard.view.v1";

export const loadViewState = (storage?: Pick<Storage, "getItem">): ViewState => {
  try {
    // 默认值在 try 内解析：沙箱 iframe / 隐私模式下读 localStorage getter 本身就抛 SecurityError，
    // 写在默认参数里会逃逸 try 直接炸整板
    const store = storage ?? localStorage;
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VIEW_STATE;
    const parsed = JSON.parse(raw) as Partial<ViewState>;
    return {
      query: typeof parsed.query === "string" ? parsed.query : DEFAULT_VIEW_STATE.query,
      workspace: typeof parsed.workspace === "string" ? parsed.workspace : DEFAULT_VIEW_STATE.workspace,
      compact: typeof parsed.compact === "boolean" ? parsed.compact : DEFAULT_VIEW_STATE.compact,
      archivedVisible:
        typeof parsed.archivedVisible === "boolean" ? parsed.archivedVisible : DEFAULT_VIEW_STATE.archivedVisible,
    };
  } catch {
    return DEFAULT_VIEW_STATE;
  }
};

export const saveViewState = (view: ViewState, storage?: Pick<Storage, "setItem">): void => {
  try {
    (storage ?? localStorage).setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // 隐私模式等 storage 不可用场景：视图状态丢失可接受，不阻塞看板
  }
};
