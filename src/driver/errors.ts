/** driver 层错误：客户端把 app-server 的失败映射成这些类型，上层按人话记录，绝不静默换路。 */

/** 协议失配/非法应答：版本大版本不一致、initialize 拒绝、应答缺字段等。 */
export class DriverProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverProtocolError";
  }
}

/** app-server 子进程退出/断连：所有在飞请求一并失败，客户端标记死亡，下次使用重建。 */
export class DriverDisconnectedError extends Error {
  constructor(detail = "app-server process exited") {
    super(detail);
    this.name = "DriverDisconnectedError";
  }
}

/** 单个请求超时：只判该请求失败，不断连（server 可能只是慢）。 */
export class DriverTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`app-server request ${method} timed out after ${timeoutMs}ms`);
    this.name = "DriverTimeoutError";
  }
}

/** 能力注册表明确记录不可用的 method：明确报能力错误，不发到线上。 */
export class CapabilityUnavailableError extends Error {
  constructor(method: string) {
    super(`capability unavailable: ${method} was not found on this app-server (capability registry)`);
    this.name = "CapabilityUnavailableError";
  }
}
