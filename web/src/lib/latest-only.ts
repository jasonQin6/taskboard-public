/**
 * latest-only 拉取原语（issue #36，GLOSSARY「latest-only 拉取」；晨析 10-25 内化 rescue、补 dispose）：
 * model 层与视图 hook 手写 single-flight + latest-wins 守卫的收敛点。覆盖共同语义：key 变化丢弃
 * （请求发起时捕获当前 key，结果返回时 key 已变即丢弃）与 pending 重入队（同 key 在飞时后续调用
 * 排队、只保留最后一次，完成后出队补跑）。早退（key 丢弃）与被吞异常路径的排队意图由原语内部
 * 补跑（原 rescue 选项内化——吞掉异常才补跑；onError 重抛或缺省上抛则交还调用方失败契约，不自救）；
 * 补跑轮重新回调 onAcquire（与旧 rescue 另起一轮的语义一致）。dispose 供组件卸载终结槽位
 * （在飞结果不落、后续 run 空转）。仍不收：board-model eventLoop 的 generation 世代守卫
 * （SSE 循环退役语义，非数据过期竞态）；detail-model loadMore 追加分页的 in-flight 丢弃
 * （分页意图非全量重拉，keep-last 排队会造成重复拉页——drop 语义与本原语不同，第三个同型消费点出现再立项）。
 */
export interface LatestOnlyOptions<K> {
  /** 捕获源：每轮请求发起前取当前 key，结果返回后复取一次，两值不同则丢弃本轮结果。相等判定为 `!==`——对象 key 须由调用方保证稳定引用（或改用原始值）。 */
  getKey: () => K;
  /**
   * 赢得在飞槽位时回调一次（排队调用不回调；自救补跑轮视为重新赢得槽位、再次回调）——
   * 如详情层的 loading 置位。同步执行且异常经 onError 收场，finally 仍会复位在飞槽位
   * （不因回调异常永久卡死）。
   */
  onAcquire?: () => void;
  /**
   * 异常处理器：提供时 op/commit/onAcquire 的异常交给它（处理器返回 = 吞掉，吞掉且仍有排队
   * 意图时原语内部补跑，如 reload 的错误落地；处理器再抛出 = 照常上抛且不自救，如 pull 落
   * lastError 后保持 refresh 的失败契约）；缺省时异常原样上抛给本次 run 的调用方。
   */
  onError?: (error: unknown) => void;
}

export interface LatestOnlySlot<K> {
  /**
   * 发起一次 latest-only 拉取：op 负责取数（收到发起时捕获的 key），commit 负责落状态
   * （仅当 key 未变时被调用）。在飞时本次调用并入排队意图（keep-last）即刻返回。
   * op 抛错时原样上抛给本次 run 的调用方。
   */
  run: <T>(op: (key: K) => Promise<T>, commit: (result: T, key: K) => void) => Promise<void>;
  /**
   * 终结槽位：在飞请求的结果回来不再 commit、后续 run 直接空转（排队意图一并作废）。
   * 组件 effect cleanup 处替代手写 alive 守卫；长驻 model 不需要调用。
   */
  dispose: () => void;
}

export const createLatestOnly = <K>(options: LatestOnlyOptions<K>): LatestOnlySlot<K> => {
  const { getKey, onAcquire, onError } = options;
  let inFlight = false;
  let pending = false;
  let disposed = false;
  /** 异常的统一出口：有处理器交处理器（可吞可重抛），无处理器原样上抛。 */
  const handleError = (error: unknown): void => {
    if (onError) onError(error);
    else throw error;
  };
  return {
    run: async (op, commit) => {
      if (disposed) return;
      if (inFlight) {
        // keep-last：只保留一次重跑意图，在飞期间的后续调用全部合并
        pending = true;
        return;
      }
      inFlight = true;
      try {
        try {
          onAcquire?.();
        } catch (error) {
          // 取槽位回调抛错：无排队意图可言（槽位尚未发起任何请求），收场即退出
          handleError(error);
          return;
        }
        // 自救补跑轮（key 丢弃/吞错后仍带排队意图）：与旧 rescue 另起一轮等价，重新回调 onAcquire
        let selfRescue = false;
        do {
          if (disposed) return;
          pending = false;
          if (selfRescue) {
            selfRescue = false;
            try {
              onAcquire?.();
            } catch (error) {
              handleError(error);
              return;
            }
          }
          try {
            // 每轮循环重新捕获：跨 await 的读取不保留外层收窄，且补跑要用最新 key
            const key = getKey();
            const result = await op(key);
            if (disposed) return;
            // key 变化丢弃：结果已过期不落状态；是否有排队意图（如切线程后的 open）交 while 判定
            if (getKey() !== key) {
              selfRescue = true;
              continue;
            }
            commit(result, key);
          } catch (error) {
            // 吞掉则按 pending 判定自救补跑；重抛穿过 do-while 直达调用方（finally 仍复位槽位）
            handleError(error);
            selfRescue = true;
          }
        } while (pending);
      } finally {
        inFlight = false;
      }
    },
    dispose: () => {
      disposed = true;
    },
  };
};
