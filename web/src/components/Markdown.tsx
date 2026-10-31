import { renderMarkdown } from "../lib/markdown.js";

/** 唯一允许 dangerouslySetInnerHTML 的位置：渲染器先整体转义再套白名单（见 test/markdown.test.ts）。 */
export const Markdown = ({ text }: { text: string }) => {
  if (text.trim() === "") return null;
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
};
