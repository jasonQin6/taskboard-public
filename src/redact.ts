/**
 * 脱敏与截断：rollout 文本入库前的唯一通道（需求「证据持久化边界」：出站标准 = 入站标准）。
 * 规则刻意保守：长随机 payload（≥32 位）一律遮。`/` 与 `=` 不算 payload——路径段与
 * `key=value` 因此提前断开，深路径、`id=<uuid>` 这类可关联上下文不再被整体吞掉；
 * 被 `/` 劈开的分段 base64 由 SPLIT_B64 兜底（带 +/= alphabet 特征且总长 ≥32 仍整体遮），
 * 纯字母数字且无特征的分段串不再整体遮（与 JWT 靠 `.` 天然不断同理，已知取舍）。
 */

/** 长 hex/base64 随机串（≥32 位）几乎只可能是凭据/令牌；UUID 因带连字符不匹配。 */
const LONG_RUN = /[A-Za-z0-9+_-]{32,}/g;
// 收窄 payload 后的唯一漏网面：密钥本体被 `/` 分段、每段皆不足 32。+/= 是 base64 的
// alphabet 特征，出现即按密钥处理；纯字母数字分段串更像路径，放过
const SPLIT_B64 = /[A-Za-z0-9+_=]+(?:\/[A-Za-z0-9+_=]+)+/g;
// i 旗：小写 bearer/sk-/akia 变体同样过遮；令牌本体长度不足 32 时这是唯一拦截面
const BEARER_PREFIX =
  /\b(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]+)/gi;

const EXACT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMBEDDED_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const redact = (text: string): string =>
  text
    .replace(BEARER_PREFIX, "[redacted]")
    .replace(LONG_RUN, (match) => {
      // 精确 UUID 不是凭据，保留；run 内嵌 UUID（`xx<uuid>yy` 无分隔贴合时）保留 UUID 本体、
      // 遮其余——可关联性是证据层存在的目的，而 UUID 前缀不是秘密
      if (EXACT_UUID.test(match)) return match;
      const embedded = EMBEDDED_UUID.exec(match);
      return embedded === null ? "[redacted]" : `[redacted]${embedded[0]}`;
    })
    .replace(SPLIT_B64, (match) =>
      match.length >= 32 && /[+=]/.test(match) ? "[redacted]" : match,
    );

/** 脱敏 + 截断为短摘录；截断发生在脱敏之后，避免把被遮断的密钥留在尾部。 */
export const redactExcerpt = (text: string, maxChars = 280): string => {
  const clean = redact(text);
  if (clean.length <= maxChars) return clean;
  // slice 按 UTF-16 码元切：边界落在代理对中间会把半个 emoji 持久化成坏码元
  let end = maxChars;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${clean.slice(0, end)}…`;
};
