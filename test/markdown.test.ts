/**
 * Markdown 白名单渲染（issue #6，需求「安全边界」）：rollout 来源文本是不可信数据，
 * 先整体转义再套白名单，任何非白名单语法必须以纯文本原样出现。
 * 渲染器是纯函数，放 web/src/lib 供 React 与本测试共用。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../web/src/lib/markdown.js";

test("markdown: plain text is HTML-escaped", () => {
  assert.equal(
    renderMarkdown("a < b & c > d"),
    "<p>a &lt; b &amp; c &gt; d</p>",
  );
});

test("markdown: html injection is never passed through", () => {
  const out = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(2)>');
  assert.ok(!out.includes("<script"), out);
  assert.ok(!out.includes("<img"), out);
  assert.ok(out.includes("&lt;script&gt;"), out);
});

test("markdown: whitelisted emphasis and inline code render as tags", () => {
  assert.equal(
    renderMarkdown("**bold** and *em* and `code`"),
    "<p><strong>bold</strong> and <em>em</em> and <code>code</code></p>",
  );
});

test("markdown: headings and list items render as whitelisted block tags", () => {
  assert.equal(renderMarkdown("## Title\n- one\n- two"), "<h2>Title</h2><ul><li>one</li><li>two</li></ul>");
});

test("markdown: links only allow http(s); javascript: href is neutralized", () => {
  assert.equal(
    renderMarkdown("[docs](https://example.com/a)"),
    '<p><a href="https://example.com/a" rel="noopener noreferrer" target="_blank">docs</a></p>',
  );
  const evil = renderMarkdown("[x](javascript:alert(1))");
  assert.ok(!evil.includes("javascript:"), evil);
  assert.ok(evil.includes("x"), evil);
});

test("markdown: paragraphs split on blank lines, single newlines become <br>", () => {
  assert.equal(renderMarkdown("one\ntwo\n\nthree"), "<p>one<br>two</p><p>three</p>");
});

test("markdown: code fence renders as pre>code with escaped content", () => {
  const out = renderMarkdown("```\n<b>&raw\n```");
  assert.ok(out.startsWith("<pre><code>"), out);
  assert.ok(out.includes("&lt;b&gt;&amp;raw"), out);
});

test("markdown: placeholder restore is slot-kind aware (link slot is not satisfied by code span)", () => {
  // 回归：恢复占位符曾只按数字索引查 slots.code，links:0 被 code[0] 顶掉，锚点整段丢失
  const out = renderMarkdown("`a` [b](http://c)");
  assert.ok(out.includes("<code>a</code>"), out);
  assert.ok(out.includes('<a href="http://c"'), out);
  const out2 = renderMarkdown("[b](http://c) `a`");
  assert.ok(out2.includes('<a href="http://c"'), out2);
  assert.ok(out2.includes("<code>a</code>"), out2);
});

test("markdown: NUL bytes are stripped so forged placeholder markers cannot hijack restore", () => {
  // 回归：正文里的字面 \u0000code:0\u0000 曾冒充占位符取走 code[0] 的 HTML 并复制内容
  const out = renderMarkdown("x\u0000code:0\u0000 `a`");
  assert.ok(!out.includes("\u0000"), out);
  assert.equal(out.split("<code>a</code>").length - 1, 1, out);
  assert.ok(out.includes("code:0"), out); // 伪造标记降级为纯文本
});

test("markdown: code fence with language tag opens and closes; body skips inline syntax", () => {
  // 回归：```ts 开栏曾不识别，代码体被当段落渲染（粗体/行内码/链接语法被篡改）
  const out = renderMarkdown("```ts\nconst a = `x` && [b](http://c)\n```");
  assert.ok(out.startsWith("<pre><code>"), out);
  assert.ok(out.includes("const a = `x` &amp;&amp; [b](http://c)"), out);
  assert.ok(!out.includes("<strong>") && !out.includes("<a href"), out);
});
