/** 反代安全栅栏（纯函数裁决）。只认 socket 远端地址，不解析 X-Forwarded-For 等可伪造头。 */

import { timingSafeEqual } from "node:crypto";

/** 反代必须覆写的令牌头（追加式伪造会被 Node 的重复头合并拼串，比对必不等）。 */
export const PROXY_TOKEN_HEADER = "x-taskboard-token";

export type TrustedHostEntry =
  | { kind: "ipv4"; ip: number }
  | { kind: "ipv4-cidr"; base: number; bits: number }
  | { kind: "ipv6"; ip: string };

export interface ProxyGuardConfig {
  trustedHosts: TrustedHostEntry[];
  /** 已解析的令牌值；undefined = 未配置令牌环节（仅按来源把门）。 */
  token?: string;
}

export type ProxyGuardVerdict =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; error: string };

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const parseIpv4 = (value: string): number | undefined => {
  const match = IPV4_PATTERN.exec(value);
  if (match === null) return undefined;
  let result = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (octet > 255) return undefined;
    result = result * 256 + octet;
  }
  return result >>> 0;
};

/** 解析受信列表；任何非法条目都抛错（配置错误失败关闭，不带病运行）。 */
export const parseTrustedHosts = (raw: readonly string[]): TrustedHostEntry[] =>
  raw.map((entry) => {
    const trimmed = entry.trim();
    const cidrMatch = /^([^/]+)\/(\d{1,3})$/.exec(trimmed);
    if (cidrMatch !== null) {
      const base = parseIpv4(cidrMatch[1]!);
      const bits = Number(cidrMatch[2]);
      if (base === undefined || bits > 32) {
        throw new Error(`invalid trusted proxy host entry: ${JSON.stringify(entry)}`);
      }
      return { kind: "ipv4-cidr", base, bits } as TrustedHostEntry;
    }
    if (trimmed.includes(":")) {
      return { kind: "ipv6", ip: trimmed.toLowerCase() } as TrustedHostEntry;
    }
    const ip = parseIpv4(trimmed);
    if (ip !== undefined) return { kind: "ipv4", ip } as TrustedHostEntry;
    throw new Error(`invalid trusted proxy host entry: ${JSON.stringify(entry)}`);
  });

/** IPv6 socket 上的 IPv4 呈 ::ffff:a.b.c.d 映射形：剥前缀按 IPv4 处理。 */
export const normalizeRemoteAddress = (address: string | undefined): string | undefined => {
  if (address === undefined) return undefined;
  if (address.startsWith("::ffff:")) {
    const mapped = address.slice("::ffff:".length);
    if (parseIpv4(mapped) !== undefined) return mapped;
  }
  return address;
};

export const isLoopbackAddress = (address: string | undefined): boolean => {
  const normalized = normalizeRemoteAddress(address);
  if (normalized === undefined) return false;
  if (normalized === "::1") return true;
  const ipv4 = parseIpv4(normalized);
  return ipv4 !== undefined && ipv4 >>> 24 === 127;
};

const addressInTrustedHosts = (
  trustedHosts: TrustedHostEntry[],
  address: string | undefined,
): boolean => {
  const normalized = normalizeRemoteAddress(address);
  if (normalized === undefined) return false;
  const ipv6 = normalized.includes(":") ? normalized.toLowerCase() : undefined;
  const ipv4 = ipv6 === undefined ? parseIpv4(normalized) : undefined;
  if (ipv4 === undefined && ipv6 === undefined) return false;
  return trustedHosts.some((entry) => {
    if (entry.kind === "ipv6") return ipv6 !== undefined && entry.ip === ipv6;
    if (ipv4 === undefined) return false;
    if (entry.kind === "ipv4") return entry.ip === ipv4;
    const mask = entry.bits === 0 ? 0 : (0xffffffff << (32 - entry.bits)) >>> 0;
    return (entry.base & mask) === (ipv4 & mask);
  });
};

/** 常量时间令牌比对；长度不等的直接否（timingSafeEqual 只收等长输入）。 */
const tokenEquals = (presented: string, expected: string): boolean => {
  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
};

const READ_METHODS = new Set(["GET", "HEAD"]);
const UNTRUSTED_SOURCE: ProxyGuardVerdict = {
  allowed: false,
  status: 403,
  error: "request source is not a trusted proxy",
};
const BAD_TOKEN: ProxyGuardVerdict = {
  allowed: false,
  status: 401,
  error: "proxy token missing or incorrect",
};

/** 写面无本机豁免：同机反代与本机用户来源不可区分，改状态必须过令牌。 */
export const evaluateProxyGuard = (
  guard: ProxyGuardConfig | undefined,
  input: {
    method?: string;
    remoteAddress?: string | undefined;
    tokenHeader?: string | string[] | undefined;
  },
): ProxyGuardVerdict => {
  if (guard === undefined) return { allowed: true };
// 读面（GET/HEAD）本机回环放行：CLI/看板本机使用不需要令牌。
  if (READ_METHODS.has(input.method ?? "") && isLoopbackAddress(input.remoteAddress)) {
    return { allowed: true };
  }
  if (!addressInTrustedHosts(guard.trustedHosts, input.remoteAddress)) return UNTRUSTED_SOURCE;
  if (guard.token !== undefined) {
    // Node 把重复头合并为 ", " 串：数组形态拼回字符串后与期望值精确比对（追加式伪造必不等）。
    const presented = Array.isArray(input.tokenHeader)
      ? input.tokenHeader.join(",")
      : input.tokenHeader;
    if (presented === undefined || !tokenEquals(presented, guard.token)) return BAD_TOKEN;
  }
  return { allowed: true };
};

export interface AssembleProxyGuardOptions {
  trustedProxyHosts: readonly string[];
  proxyTokenEnv?: string;
  proxyToken?: string;
  env?: NodeJS.ProcessEnv;
}

/** 空受信列表 = 栅栏关；令牌值只活在返回的 config 里，不得打印。 */
export const assembleProxyGuard = (
  options: AssembleProxyGuardOptions,
): ProxyGuardConfig | undefined => {
  if (options.trustedProxyHosts.length === 0) return undefined;
  let token: string | undefined;
  if (options.proxyTokenEnv !== undefined) {
    const fromEnv = (options.env ?? process.env)[options.proxyTokenEnv];
    const value = options.proxyToken ?? fromEnv;
    // 空白值视同未配置：带着半截秘密跑比失败关闭更危险（配置错误不带病运行）。
    if (value === undefined || value.trim().length === 0) {
      throw new Error(
        `proxy token environment variable ${options.proxyTokenEnv} is not set; ` +
          "set it or drop the proxy-token-env setting (guard is enabled by trustedProxyHosts)",
      );
    }
    token = value;
  } else if (options.proxyToken !== undefined) {
    token = options.proxyToken;
  }
  return {
    trustedHosts: parseTrustedHosts(options.trustedProxyHosts),
    ...(token !== undefined ? { token } : {}),
  };
};
