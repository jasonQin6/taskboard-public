/** 领域错误：HTTP 状态与 CLI 退出码的公共映射源（0/1/2/3 见 cli.ts）。 */

import { CapabilityUnavailableError as DriverCapabilityUnavailableError } from "./driver/errors.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** 执行面未装配（测试/裸装配场景）时的明确拒绝；绝不静默成功。 */
export class CapabilityNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityNotImplementedError";
  }
}

// 「能力探测不可用」的唯一类在 driver/errors.ts——这里曾复刻同名类，instanceof 跨类失配漏接，勿再复刻。

export const httpStatusFor = (error: unknown): number => {
  if (error instanceof ValidationError) return 400;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ConflictError) return 409;
  if (error instanceof CapabilityNotImplementedError) return 501;
  // driver 层能力错误同样按 501 暴露（A17：app-server 不支持时明确失败，而非 500 冒充内部错误）
  if (error instanceof DriverCapabilityUnavailableError) return 501;
  return 500;
};
