import type { SystemOneFailureCode } from "./contract.js";

export class SystemOneProviderError extends Error {
  readonly code: SystemOneFailureCode;
  constructor(code: SystemOneFailureCode, message: string) {
    super(message);
    this.name = "SystemOneProviderError";
    this.code = code;
  }
}
