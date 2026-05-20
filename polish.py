#!/usr/bin/env python3
"""Polish a raw transcript using the user's local claude or codex CLI in headless mode."""
import os, sys
_venv = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".venv", "bin", "python3")
if os.path.exists(_venv) and os.path.abspath(sys.executable) != os.path.abspath(_venv):
    os.execv(_venv, [_venv] + sys.argv)

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


SYSTEM_PROMPT = """你是一名专业的中文播客编辑。用户会给你一段原始的语音转录稿，每段开头带 `[HH:MM:SS]` 时间戳，可能还有说话人标签（SPEAKER_00、SPEAKER_01 …）。请把它整理成一份易读的播客文字稿。

要求：

1. **去碎嘴**：删除"嗯""啊""呃""那个""就是""然后""所以说""对吧""是吧"这类无信息量的填充词；保留有意义的语气。
2. **修语病**：把口语化的不通顺表达改成完整流畅的句子；不改变原意。
3. **纠错字**：根据上下文修正语音识别的同音字、专有名词错误。
4. **合断句**：把被切碎的同一句话或同一说话人连续多段合并完整；合并时**只保留第一段的 `[HH:MM:SS]` 时间戳**。
5. **加段落**：在话题转换处空行分段。
6. **认人**：如果上下文能推断出说话人真实姓名（自我介绍、互相称呼"X 老师"），就用真名替换 SPEAKER_XX。无法判断时用"主播""嘉宾 A"等。同一份稿子里同一说话人的称呼必须保持一致。
7. **保原意**：只做"读起来更顺"的工作。不总结、不发挥、不省略实质内容、不加任何前言或编辑说明。
8. **保时间戳**：每段输出必须以原文中对应的 `[HH:MM:SS]` 时间戳开头，**严禁删除、修改或编造时间戳**。

输出格式：每段写作 `[HH:MM:SS] **说话人**：内容`（如果原文没有说话人标签则省略 `**说话人**：`），不同段之间空一行。直接输出整理后的稿件本体，不要任何额外说明。"""


SOURCE_RE = re.compile(r"^<!--\s*source:\s*(.+?)\s*-->\s*$", re.MULTILINE)
TIMESTAMP_RE = re.compile(r"\[(\d{2}):(\d{2}):(\d{2})\]")


def extract_source(raw: str) -> str | None:
    m = SOURCE_RE.search(raw)
    return m.group(1).strip() if m else None


def _url_with_timestamp(base: str, seconds: int) -> str:
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}t={seconds}"


def linkify_timestamps(text: str, base_url: str) -> str:
    def repl(m: re.Match) -> str:
        h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
        total = h * 3600 + mi * 60 + s
        return f"[`{m.group(0)[1:-1]}`]({_url_with_timestamp(base_url, total)})"
    return TIMESTAMP_RE.sub(repl, text)


def chunk_transcript(text: str, max_chars: int = 8000) -> list[str]:
    """Split at speaker-turn boundaries (blank lines) to keep chunks ≤max_chars."""
    paragraphs = [p for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for p in paragraphs:
        if cur and cur_len + len(p) + 2 > max_chars:
            chunks.append("\n\n".join(cur))
            cur = [p]
            cur_len = len(p)
        else:
            cur.append(p)
            cur_len += len(p) + 2
    if cur:
        chunks.append("\n\n".join(cur))
    return chunks


def _build_user_message(chunk: str, prior_tail: str) -> str:
    if not prior_tail:
        return f"原文：\n---\n{chunk}\n---"
    return (
        "前文已整理（仅用于保持说话人称呼一致和语气连贯，不要重复输出）：\n"
        f"---\n{prior_tail}\n---\n\n"
        f"现在请整理这一段：\n---\n{chunk}\n---"
    )


def resolve_cli(preferred: str | None) -> str:
    """Pick which headless CLI to use. Order: explicit flag > claude > codex."""
    candidates = [preferred] if preferred else ["claude", "codex"]
    for c in candidates:
        if c and shutil.which(c):
            return c
    raise SystemExit(
        "error: no usable CLI found. Install one of:\n"
        "  claude:  https://docs.claude.com/en/docs/claude-code\n"
        "  codex:   https://github.com/openai/codex\n"
        "Then make sure you're logged in (`claude` or `codex` once interactively)."
    )


def call_cli(cli: str, prompt: str, model: str | None) -> str:
    """Run the headless CLI with `prompt` as the full input. Returns the assistant text."""
    if cli == "claude":
        cmd = ["claude", "-p"]
    elif cli == "codex":
        cmd = ["codex", "exec"]
    else:
        raise SystemExit(f"unknown cli: {cli}")
    if model:
        cmd += ["--model", model]
    cmd.append(prompt)

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(
            f"{cli} CLI failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
        )
    return proc.stdout.strip()


def polish(raw: str, cli: str, model: str | None, partial_path: Path) -> str:
    chunks = chunk_transcript(raw)

    done: dict[int, str] = {}
    if partial_path.exists():
        for line in partial_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                done[int(rec["i"])] = rec["text"]
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
        if done:
            print(
                f"resuming: {len(done)}/{len(chunks)} chunk(s) already polished",
                file=sys.stderr,
            )

    model_label = model or "default"
    print(
        f"polishing {len(chunks)} chunk(s) via `{cli}` ({model_label})...",
        file=sys.stderr,
    )

    with partial_path.open("a", encoding="utf-8") as partial_f:
        for i, chunk in enumerate(chunks, 1):
            if i in done:
                print(f"  [{i}/{len(chunks)}] (cached)", file=sys.stderr)
                continue
            print(f"  [{i}/{len(chunks)}]", file=sys.stderr)
            prior = done.get(i - 1, "")
            tail = prior[-1200:] if prior else ""
            prompt = (
                f"{SYSTEM_PROMPT}\n\n---\n\n"
                + _build_user_message(chunk, tail)
            )
            text = call_cli(cli, prompt, model)
            done[i] = text
            partial_f.write(
                json.dumps({"i": i, "text": text}, ensure_ascii=False) + "\n"
            )
            partial_f.flush()

    return "\n\n".join(done[i] for i in sorted(done))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Raw transcript markdown file")
    parser.add_argument("-o", "--output", help="Output path (default: <input minus .raw>.md)")
    parser.add_argument(
        "--cli", choices=["claude", "codex"],
        help="Which local CLI to call (default: auto-detect, prefers claude)",
    )
    parser.add_argument("--model", help="Pin a model id (passed to the CLI as --model)")
    args = parser.parse_args()

    cli = resolve_cli(args.cli)

    in_path = Path(args.input)
    raw = in_path.read_text(encoding="utf-8")
    source_url = extract_source(raw)

    if args.output:
        out_path = Path(args.output)
    elif in_path.name.endswith(".raw.md"):
        out_path = in_path.with_name(in_path.name[:-len(".raw.md")] + ".md")
    else:
        out_path = in_path.with_suffix(".polished.md")

    partial_path = out_path.with_suffix(out_path.suffix + ".partial.jsonl")

    polished = polish(raw, cli=cli, model=args.model, partial_path=partial_path)

    if source_url:
        polished = linkify_timestamps(polished, source_url)
        print(f"  embedded jump links → {source_url}", file=sys.stderr)

    out_path.write_text(polished, encoding="utf-8")
    partial_path.unlink(missing_ok=True)
    print(f"\n✓ polished transcript: {out_path}", file=sys.stderr)
    print(out_path)


if __name__ == "__main__":
    main()
