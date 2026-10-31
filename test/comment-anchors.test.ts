/**
 * 注释锚点纪律（#45 事故：设计稿落仓外临时目录、注释引用 design.md 与节号等幽灵锚点，最后
 * 只能靠 no-comments 全量回收）：用 TS 词法注释做确定性检查——禁仓外绝对路径、禁节号锚点
 * （本仓文档无节号符号）、注释里引用的 .md 必须在仓内真实存在。AGENTS.md 定过时注释按 bug
 * 处理，这里把它从纪律变成测试。只扫 TS 词法注释（单行与块注释）；JSX 花括号注释与 CSS
 * 注释不在词法注释范围内，本仓注释纪律针对的是 TS 注释。test/ 不扫：测试头注释合法地
 * 引述事故样例。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["src", "web/src", "scripts"];
const scanExts = new Set([".ts", ".tsx", ".mjs"]);

function commentTexts(source: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false);
  scanner.setText(source);
  const texts: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      texts.push(scanner.getTokenText());
    }
  }
  return texts;
}

function anchorProblems(comment: string, file: string): string[] {
  const problems: string[] = [];
  if (comment.includes("/tmp/")) problems.push("仓外绝对路径 /tmp/");
  if (comment.includes("§")) problems.push("节号锚点 §（本仓文档无 § 编号）");
  for (const ref of comment.match(/[\w./-]+\.md/g) ?? []) {
    const clean = ref.replace(/^\.\//, "");
    const atRoot = fs.existsSync(path.join(repoRoot, clean));
    const atFile = fs.existsSync(path.join(path.dirname(file), clean));
    if (!atRoot && !atFile) problems.push(`引用不存在的文档 ${ref}`);
  }
  return problems;
}

test("探测器：幽灵锚点样例逐条命中，合法锚点不误伤", () => {
  const dirty = anchorProblems("见 /tmp/systemone-arena/design.md §7.5 的 13 步", "src/x.ts");
  assert.ok(dirty.some((p) => p.includes("/tmp/")));
  assert.ok(dirty.some((p) => p.includes("§")));
  assert.ok(dirty.some((p) => p.includes("design.md")));
  // 命中 /tmp 的引用即使碰巧同名单据也不放行：路径本身就是仓外锚点
  assert.deepEqual(anchorProblems("措辞以 GLOSSARY.md 为准；见 docs/spec/phase1-observation-mvp.md「事实源」", "src/types.ts"), []);
  assert.deepEqual(anchorProblems("见 docs/adr/ADR-0019（无 .md 后缀不在检查范围）", "src/x.ts"), []);
});

test("全仓 TS 注释零幽灵锚点（src / web/src / scripts）", () => {
  const violations: string[] = [];
  for (const root of scanRoots) {
    const absRoot = path.join(repoRoot, root);
    if (!fs.existsSync(absRoot)) continue;
    for (const rel of fs.readdirSync(absRoot, { recursive: true })) {
      const file = path.join(absRoot, rel);
      if (!scanExts.has(path.extname(file)) || !fs.statSync(file).isFile()) continue;
      for (const comment of commentTexts(fs.readFileSync(file, "utf8"))) {
        for (const problem of anchorProblems(comment, file)) {
          violations.push(`${path.relative(repoRoot, file)}: ${problem} :: ${comment.trim().slice(0, 80)}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});
