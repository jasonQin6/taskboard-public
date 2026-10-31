#!/bin/bash
# Stop hook：会话收尾 retro（#66 子功能化并入 taskboard；前身 ~/.zcode/hooks/stop-retro.sh）。
# 只对交互与 headless 会话触发（yolo 门已删——交互会话也要 retro）；dwf- 前缀会话是
# DWF 子代理（与父会话同 cwd、加载同一套 hook），显式排除；ZCODE_HOOK_GUARD 防环。
# 载荷通道零中间文件：首 Stop 注入 continuation → 模型收尾消息内嵌 ```json 块 →
# 第二次 Stop（stop_hook_active）从 stdin 的 responseText 提取 JSON →
# taskboard retro record --stdin（ADR-0023 短命写进程）。全程 fail-open：hook 故障
# 不得阻断会话结束。
set -uo pipefail

INPUT="$(cat)" || exit 0

[ -n "${ZCODE_HOOK_GUARD:-}" ] && exit 0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# hook 进程的 PATH 不保证含 node（App 启动链可能只有系统 PATH），按常见安装位兜底
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
[ -n "$NODE_BIN" ] || exit 0
TSX_BIN="$ROOT/node_modules/tsx/dist/cli.mjs"
[ -f "$TSX_BIN" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

python3 - "$INPUT" "$ROOT" "$NODE_BIN" "$TSX_BIN" <<'PY'
import datetime
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import sys

INPUT, ROOT, NODE, TSX = sys.argv[1], pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4]
ZCODE_DB = pathlib.Path.home() / ".zcode" / "cli" / "db" / "db.sqlite"
PROMPT_VERSION = "5"
HOOK_VERSION = "3"
MAX_ATTEMPTS = 3


def taskboard_db():
    env = os.environ.get("TASKBOARD_DB_PATH", "").strip()
    return pathlib.Path(env).expanduser() if env else pathlib.Path.home() / ".taskboard" / "taskboard.sqlite"


def gate_row(source, session_id):
    """触发门判定在主库上做（ADR-0024）：返回 (status, attempts) 或 None。"""
    path = taskboard_db()
    if not path.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
        row = conn.execute(
            "SELECT status, attempts FROM retro WHERE source = ? AND session_id = ?",
            (source, session_id),
        ).fetchone()
        conn.close()
        return tuple(row) if row else None
    except Exception:
        return None


def session_date(session_id):
    try:
        conn = sqlite3.connect(f"file:{ZCODE_DB}?mode=ro", uri=True, timeout=2)
        row = conn.execute(
            # time_created 是毫秒；按秒解释会越界返回 NULL，静默退化成 today()
            "SELECT date(time_created / 1000, 'unixepoch', 'localtime') FROM session WHERE id = ?",
            (session_id,),
        ).fetchone()
        conn.close()
        if row and row[0]:
            return row[0]
    except Exception:
        pass
    return datetime.date.today().isoformat()


def record(payload):
    proc = subprocess.run(
        [NODE, TSX, str(ROOT / "src" / "cli.ts"), "retro", "record", "--stdin"],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        timeout=20,
    )
    return proc.returncode == 0


def repo_requirements():
    """仓库自声明的额外要求；文件不存在则跳过该条（.zcode-retro 标志已废弃）。"""
    try:
        text = (ROOT / "docs" / "agents" / "retro-requirements.md").read_text(encoding="utf-8").strip()
    except Exception:
        return ""
    return f"\n本仓库的额外要求：\n{text}" if text else ""


SCHEMA_HINT = (
    "{\n"
    '  "conclusion": "一两句话：本会话做了什么、结果如何",\n'
    '  "findings": [{"category": "navigation|checks|standards|steering|tool-economy|no-op|info-access", '
    '"finding": "观察到的事实", "improvement": "可执行的改进", "evidence": "第N轮 + 一行原文摘录"}],\n'
    '  "notCovered": ["本会话无法判断的点"]\n'
    "}"
)


def inject_prompt(session_id):
    return (
        "【会话收尾 retro（Stop hook 强制触发，不可跳过）】\n"
        f"本会话 session_id = {session_id}。\n"
        "会话即将结束。请立即回顾本会话实际完成的工作、有效与无效的步骤、犯过的错误，"
        "提炼可沉淀的环境/流程改进，然后在收尾消息末尾输出一个 ```json 代码块（全文最后一个块）：\n"
        f"{SCHEMA_HINT}\n"
        "要求：findings 每条必须有证据（轮次 + 一行原文摘录），没有证据就不要写；"
        "只写事实与可执行改进，不复述对话；不要写任何文件、不要执行任何命令，"
        "JSON 只放进本条收尾消息；若本会话有素材卡（路径按 attempt 票约定），先读素材卡再总结。"
        + repo_requirements()
    )


def retry_prompt(reason):
    return (
        "【会话收尾 retro 重试】上一次收尾消息中的 ```json 块无法解析："
        f"{reason}。\n请重新输出一个合法的 ```json 块（字段同前：conclusion / findings / notCovered），"
        "放在收尾消息末尾；不要写文件、不要执行命令。" + repo_requirements()
    )


def extract_payload(text):
    """收尾消息里最后一个 ```json 围栏块 → (载荷, None) 或 (None, 失败原因)。"""
    if not isinstance(text, str) or not text:
        return None, "收尾消息为空，没有 ```json 块"
    blocks = re.findall(r"```json\s*(.*?)\s*```", text, re.DOTALL)
    if not blocks:
        return None, "收尾消息中没有 ```json 块"
    try:
        obj = json.loads(blocks[-1])
    except Exception as error:
        return None, f"JSON 语法错误：{error}"
    if not isinstance(obj, dict):
        return None, "JSON 块不是对象"
    conclusion = obj.get("conclusion")
    if not isinstance(conclusion, str) or not conclusion.strip():
        return None, "conclusion 缺失或为空"
    findings = obj.get("findings", [])
    not_covered = obj.get("notCovered", [])
    if not isinstance(findings, list) or not isinstance(not_covered, list):
        return None, "findings / notCovered 必须是数组"
    return {"conclusion": conclusion, "findings": findings, "notCovered": not_covered}, None


def emit_injection(context):
    sys.stdout.write(json.dumps({"continue": True, "additionalContext": context}, ensure_ascii=False))
    sys.exit(0)


try:
    data = json.loads(INPUT)
    if not isinstance(data, dict):
        sys.exit(0)
    session_id = data.get("session_id") or data.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        sys.exit(0)
    if session_id.startswith("dwf-"):
        sys.exit(0)

    mode = data.get("permission_mode") or data.get("mode") or ""
    source = "headless" if mode == "yolo" else "interactive"
    row = gate_row(source, session_id)
    attempts = row[1] if row else 0
    base = {
        "source": source,
        "sessionId": session_id,
        "cwd": data.get("cwd") or data.get("workingDirectory") or os.getcwd(),
        "sessionDate": session_date(session_id),
        "promptVersion": PROMPT_VERSION,
        "hookVersion": HOOK_VERSION,
    }

    if data.get("stop_hook_active") or data.get("stopHookActive"):
        payload, reason = extract_payload(
            data.get("responseText") or data.get("responsePreview") or ""
        )
        if payload is not None:
            record({**base, **payload, "status": "done"})
            sys.exit(0)
        if attempts >= MAX_ATTEMPTS:
            record({**base, "status": "failed", "lastError": reason[:500]})
            sys.exit(0)
        # 重试也走 continuation：注入即消耗一次预算（attempts 只增不减）
        if record({**base, "status": "open", "attempts": attempts + 1}):
            emit_injection(retry_prompt(reason))
        sys.exit(0)

    # 无行，或 failed 且 attempts<3 才注入（open/done/skipped 一律放行，防重复注入）
    if row is not None and not (row[0] == "failed" and row[1] < MAX_ATTEMPTS):
        sys.exit(0)
    if record({**base, "status": "open", "attempts": attempts + 1}):
        emit_injection(inject_prompt(session_id))
    sys.exit(0)
except Exception:
    # fail-open：hook 自身故障不得阻断会话结束
    sys.exit(0)
PY
