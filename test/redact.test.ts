/** 脱敏与截断：入库 = 出站同一条标准（需求「证据持久化边界」「安全边界」）。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { redact, redactExcerpt } from "../src/redact.js";

test("redact masks token-like secrets but keeps normal prose untouched", () => {
  const text =
    "use OPENAI_API_KEY=sk-proj-ABCDEF0123456789ABCDEF0123456789 to call, ghp_0123456789abcdef0123456789ABCDEF0123 too";
  const out = redact(text);
  assert.ok(!out.includes("sk-proj-ABCDEF"), out);
  assert.ok(!out.includes("ghp_0123456789"), out);
  assert.ok(out.includes("use") && out.includes("to call"), "prose kept");
});

test("redact masks long hex/base64 runs and AWS access keys", () => {
  assert.ok(redact("id 0123456789abcdef0123456789abcdef01234567 done").includes("[redacted]"));
  assert.ok(!redact("AKIAIOSFODNN7EXAMPLE").includes("AKIAIOSFODNN7EXAMPLE"));
  // 普通短词、路径、UUID 不误伤
  const normal = redact("see /Users/example/file.ts and 01a1585d-9490-7d23-a001-eabde990fff5");
  assert.equal(normal, "see /Users/example/file.ts and 01a1585d-9490-7d23-a001-eabde990fff5");
});

test("over-redaction converges: deep paths and key=value runs stay readable, random payloads stay masked", () => {
  // 深路径（各段皆短词）不再因总长 ≥32 被整体吞掉——可关联上下文是证据层的目的
  const deepPath = "cwd /Users/someone/projects/deeply/nested/dir/file needs a look";
  assert.equal(redact(deepPath), deepPath);
  // key=value：键名与等号保留，只有长随机值本身被遮
  assert.equal(
    redact("password=0123456789abcdef0123456789abcdef end"),
    "password=[redacted] end",
  );
  // `id=<uuid>` 关联标识整段保留（等号断开后 UUID 命中精确豁免）
  const withUuid = "run id=550e8400-e29b-41d4-a716-446655440000 finished";
  assert.equal(redact(withUuid), withUuid);
  // 真随机串的保守默认不放松：sha256 这类长 hex 仍遮
  const sha = redact("sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  assert.ok(!sha.includes("0123456789abcdef0123456789abcdef01234567"), sha);
  // 被 `/` 劈开的分段 base64（带 +/= alphabet 特征且总长 ≥32）仍整体遮，不因收窄漏成两截
  const split = "blob MIIExAmPlE+WithPlus/someTail00001111222233334444 done";
  assert.ok(!redact(split).includes("MIIExAmPlE"), redact(split));
});

test("redactExcerpt never splits a surrogate pair at the truncation boundary", () => {
  const text = `${"x".repeat(10)}😀${"y".repeat(5)}`;
  // 边界落在代理对中间：高位代理项不得单独留在尾部（半个 emoji 持久化即坏码元）
  assert.equal(redactExcerpt(text, 11), `${"x".repeat(10)}…`);
  // 边界不落在代理对上：行为不变
  assert.equal(redactExcerpt(text, 12), `${"x".repeat(10)}😀…`);
});

test("redactExcerpt truncates with ellipsis beyond the cap and redacts first", () => {
  const secret = `先说明结论：token sk-ABCDEF0123456789ABCDEF0123456789 已泄漏，${"这是一段足够长的普通中文文本。".repeat(30)}`;
  const out = redactExcerpt(secret, 80);
  assert.ok(out.length <= 81, `length ${out.length}`);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("sk-ABCDEF"));
  assert.equal(redactExcerpt("short", 80), "short");
});
