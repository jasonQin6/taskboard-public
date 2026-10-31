/* zcode-workflow
description: taskboard 确定性验证门：在当前检出依次跑 pnpm typecheck / pnpm test / pnpm test:ui
  三道门，退出码即判定，零子代理，门输出不进调用方上下文；test 首红自动复跑一次区分 flake 与稳定失败；
  交付逐门退出码、失败尾部与 notCovered 的验证报告。
whenToUse: goal 主代理在实现单元绿灯提交后或整票最终验证时，需要确定性跑全部门并拿结构化判定；
  或用户要求「跑验证门 / 验证当前检出」。
*/
// 零子代理是有意设计：门的判定全由退出码决定，起 subagent 只会复读同一份输出（DWF 契约 §10）。

interface GateResult {
  /** 门名。 */
  gate: string;
  /** 实际执行的命令。 */
  command: string;
  /** 进程退出码，0 为绿。 */
  exit: number;
  /** 输出末尾，红门或 flake 定位用；绿门留空。 */
  tail: string;
  /** 仅 pnpm test：首红后复跑一次，绿 = flake，红 = 稳定失败。 */
  rerun?: "pass" | "fail";
}

interface Finding {
  /** 出问题的门命令。 */
  where: string;
  /** 一句话：什么没过。 */
  what: string;
  /** 退出码与输出末尾。 */
  evidence: string;
  /** 退出码是确定性判定，一律 verified。 */
  status: "verified" | "unconfirmed";
  /** 稳定红 = high；flake = medium。 */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** 两三句：三门判定结论与验证位置。 */
  conclusion: string;
  findings: Finding[];
  /** 实际跑过的命令与退出码、改动面。 */
  verified: string[];
  /** 没能检查的与原因。 */
  notCovered: string[];
}

function outTail(out: { stdout: string; stderr: string }): string {
  return `${out.stdout}\n${out.stderr}`.slice(-1800).trim();
}

// 环境读数只喂报告描述，按契约 §8 纯脚本逻辑不开阶段。
let head = "";
let changedCount = -1;
try {
  head = (await git.log(1))[0].hash.slice(0, 7);
} catch {
  // 非 git 检出不废掉门本身
}
try {
  changedCount = (await git.changedFiles()).length;
} catch {
  // 同上
}
let systemone = false;
try {
  systemone = (await files.glob("src/systemone/*.ts")).length > 0;
} catch {
  // 同上
}

phase("跑类型检查");
log("pnpm typecheck");
const tc = await world.run("pnpm", ["typecheck"], { timeoutMs: 300_000 });
const typecheckGate: GateResult = {
  gate: "类型检查",
  command: "pnpm typecheck",
  exit: tc.exitCode,
  tail: tc.exitCode === 0 ? "" : outTail(tc),
};
report(typecheckGate);
log(typecheckGate.exit === 0 ? "类型检查通过" : `类型检查失败，退出码 ${tc.exitCode}`);

phase("跑单元测试，首红复跑一次定夺 flake");
log("pnpm test");
const first = await world.run("pnpm", ["test"], { timeoutMs: 600_000 });
const unitGate: GateResult = {
  gate: "单元测试",
  command: "pnpm test",
  exit: first.exitCode,
  tail: first.exitCode === 0 ? "" : outTail(first),
};
if (first.exitCode !== 0) {
  // 门假红纪律：存量 flake 复跑定夺，稳定复现才算红门（orchestrate-subagents gotcha）
  log("单元测试首跑红，复跑一次定夺");
  const second = await world.run("pnpm", ["test"], { timeoutMs: 600_000 });
  unitGate.rerun = second.exitCode === 0 ? "pass" : "fail";
  // 复跑仍红时以复跑输出为准，复跑转绿时保留首跑现场供 flake 分析
  unitGate.tail = unitGate.rerun === "fail" ? outTail(second) : outTail(first);
}
report(unitGate);
log(
  unitGate.exit === 0
    ? "单元测试通过"
    : unitGate.rerun === "pass"
      ? "单元测试复跑转绿（flake）"
      : "单元测试稳定失败",
);

phase("跑 UI 构建与冒烟，汇总并发布报告");
log("pnpm test:ui");
const ui = await world.run("pnpm", ["test:ui"], { timeoutMs: 600_000 });
const uiGate: GateResult = {
  gate: "UI 构建与冒烟",
  command: "pnpm test:ui",
  exit: ui.exitCode,
  tail: ui.exitCode === 0 ? "" : outTail(ui),
};
report(uiGate);
log(uiGate.exit === 0 ? "UI 构建与冒烟通过" : `UI 构建与冒烟失败，退出码 ${ui.exitCode}`);

// 汇总不开新阶段：并入上一阶段（契约 §8）
const gates = [typecheckGate, unitGate, uiGate];
const red = gates.filter((g) => g.exit !== 0 && g.rerun !== "pass");
const flaky = gates.filter((g) => g.rerun === "pass");
const where =
  head !== ""
    ? `提交 ${head}，改动面 ${changedCount} 个文件（相对 HEAD，含未提交）`
    : "当前工作区（git 不可用）";

const lines = [
  "# 验证报告",
  "",
  where,
  "",
  "| 门 | 命令 | 退出码 | 复跑 |",
  "| --- | --- | --- | --- |",
  ...gates.map((g) => `| ${g.gate} | \`${g.command}\` | ${g.exit} | ${g.rerun ?? "—"} |`),
];
for (const g of red) lines.push("", `## ${g.gate} 稳定失败`, "", "```", g.tail, "```");
for (const g of flaky) lines.push("", `## ${g.gate} flake（首红复绿）`, "", "```", g.tail, "```");

await artifact.markdown("report", lines.join("\n"), {
  title: "验证报告",
  description: `${where} 的三道门结果`,
  primary: true,
});

const findings: Finding[] = [
  ...red.map(
    (g): Finding => ({
      where: g.command,
      what: `${g.gate}稳定失败，退出码 ${g.exit}`,
      evidence: g.tail,
      status: "verified",
      severity: "high",
    }),
  ),
  ...flaky.map(
    (g): Finding => ({
      where: g.command,
      what: `${g.gate}首跑红、复跑绿，按存量 flake 记，不判稳定红`,
      evidence: g.tail,
      status: "verified",
      severity: "medium",
    }),
  ),
];

const verdict =
  red.length > 0
    ? `${red.map((g) => g.gate).join("、")}稳定失败，验证不通过。`
    : flaky.length > 0
      ? `三道门无稳定失败，但 ${flaky.map((g) => g.gate).join("、")}首跑红复跑绿（flake）。`
      : "三道门全绿：类型检查、单元测试、UI 构建与冒烟。";

const result: WorkflowReport = {
  conclusion: `${verdict} 验证于${where}。`,
  findings,
  verified: gates.map(
    (g) => `${g.command} 退出码 ${g.exit}${g.rerun !== undefined ? `（复跑 ${g.rerun}）` : ""}`,
  ),
  notCovered: [
    "真实 app-server 冒烟：driver.smoke 需 TASKBOARD_SMOKE=1 与真实 codex，套件默认 skip",
    ...(systemone
      ? ["真实 Magpie 网关：需 TASKBOARD_SYSTEMONE_SMOKE=1（pnpm smoke:systemone，凭据走 .env / TASKBOARD_ENV_FILE），默认不跑"]
      : []),
  ],
};
return result;
