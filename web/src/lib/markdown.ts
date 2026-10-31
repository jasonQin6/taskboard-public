/**
 * Markdown 白名单渲染：rollout / 任务描述是不可信数据，整体先转义再套白名单语法，
 * 生成的标签只来自本文件，不存在原样 HTML 通道。不引第三方渲染器（白名单面越小越可审计）。
 */

const escapeHtml = (text: string): string =>
  text
    // NUL 先剥：正文字面 \u0000 会伪造占位符标记劫持恢复步骤（复制或吞内容）
    .replaceAll("\u0000", "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

interface InlineSlots {
  code: string[];
  links: string[];
}

/** 占位符隔离已生成的标签：后续 bold/em 匹配不得进入 code 内容或链接 URL。 */
const stash = (slots: InlineSlots, kind: "code" | "links", html: string): string => {
  slots[kind].push(html);
  return `\u0000${kind}:${slots[kind].length - 1}\u0000`;
};

const renderInline = (escaped: string): string => {
  const slots: InlineSlots = { code: [], links: [] };
  let out = escaped.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    stash(slots, "code", `<code>${code}</code>`),
  );
  out = out.replace(
    /\[([^\]\n]*)\]\(([^)\s]+)\)/g,
    (_m, text: string, url: string) => {
      // 仅 http(s) 可点击；其他 scheme 一律降级为纯文本，杜绝 javascript:/data:
      if (!/^https?:\/\//.test(url)) return text;
      return stash(
        slots,
        "links",
        `<a href="${url}" rel="noopener noreferrer" target="_blank">${text}</a>`,
      );
    },
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  return out.replace(/\u0000(code|links):(\d+)\u0000/g, (_m, kind: "code" | "links", index: string) => {
    // 按槽类型索引：links:0 不得被 code[0] 顶掉（跨槽错配会以错误形态展示不可信内容）
    return slots[kind][Number(index)] ?? "";
  });
};

export const renderMarkdown = (raw: string): string => {
  const escaped = escapeHtml(raw);
  const lines = escaped.split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let fence: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${paragraph.join("<br>")}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list.length > 0) {
      blocks.push(`<ul>${list.map((item) => `<li>${item}</li>`).join("")}</ul>`);
      list = [];
    }
  };

  for (const line of lines) {
    // 围栏开/闭都容忍语言标签（```ts 是 rollout 主流形态）；无标签的 ``` 同样命中
    if (/^```\S*$/.test(line.trim())) {
      if (fence === null) {
        flushParagraph();
        flushList();
        fence = [];
      } else {
        blocks.push(`<pre><code>${fence.join("\n")}</code></pre>`);
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.push(line);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      continue;
    }
    const listItem = /^\s*[-*]\s+(.*)$/.exec(line);
    if (listItem !== null) {
      flushParagraph();
      list.push(renderInline(listItem[1]!));
      continue;
    }
    flushList();
    paragraph.push(renderInline(line));
  }
  if (fence !== null) blocks.push(`<pre><code>${fence.join("\n")}</code></pre>`);
  flushParagraph();
  flushList();
  return blocks.join("");
};
