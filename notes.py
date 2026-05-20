#!/usr/bin/env python3
"""Generate structured study notes from a polished transcript via local claude/codex CLI."""
import os, sys
_venv = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".venv", "bin", "python3")
if os.path.exists(_venv) and os.path.abspath(sys.executable) != os.path.abspath(_venv):
    os.execv(_venv, [_venv] + sys.argv)

import argparse
from pathlib import Path

from polish import call_cli, resolve_cli


SYSTEM_PROMPT = """你是一名擅长把对话内容整理成研究笔记的中文编辑。用户会给你一份已经润色过的播客或讲座文字稿，每段开头带 `[HH:MM:SS]` 时间戳（可能是 markdown 链接形式 `[`HH:MM:SS`](url)`，请保留原样）。

请基于文字稿产出一份结构化的学习笔记，**严格按以下章节顺序输出**：

## TL;DR

用 2-4 句话概括全篇的核心结论或主要讨论了什么。不堆砌形容词，不复述目录。

## 章节大纲

按内容的自然话题切分（不是机械按时间均分）成 3-8 个章节。每个章节用二级列表呈现：

- **章节标题** `[HH:MM:SS]` — 一句话说明这一段讲了什么

时间戳取该章节起点；如果原文中是带链接的形式（`` [`HH:MM:SS`](url) ``），请原样使用整个链接，保持可点击。

## 关键观点

5-10 条要点，每条一句话，捕捉作者/嘉宾给出的实质判断、论证或事实，不是话题描述。可以在要点末尾用 `[HH:MM:SS]` 标出出处。

## 金句摘录

挑 3-6 段值得直接引用的原话，使用 markdown 引用块（`>`）。每段引用上方注明说话人与时间戳。

要求：
- 内容必须基于原文，不发挥、不臆测、不补充原文没有的信息。
- 不要重复 TL;DR、大纲、要点之间已经说过的内容。
- 全篇用简洁中文。不写客套话、不写"以下是笔记"这种前言。直接进入第一节 `## TL;DR`。"""


def build_prompt(transcript: str) -> str:
    return (
        f"{SYSTEM_PROMPT}\n\n---\n\n原始文字稿：\n---\n{transcript}\n---"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Polished transcript markdown file")
    parser.add_argument("-o", "--output", help="Output path (default: <input minus .md>.notes.md)")
    parser.add_argument(
        "--cli", choices=["claude", "codex"],
        help="Which local CLI to call (default: auto-detect, prefers claude)",
    )
    parser.add_argument("--model", help="Pin a model id (passed to the CLI as --model)")
    args = parser.parse_args()

    cli = resolve_cli(args.cli)

    in_path = Path(args.input)
    transcript = in_path.read_text(encoding="utf-8")

    if args.output:
        out_path = Path(args.output)
    elif in_path.name.endswith(".md"):
        out_path = in_path.with_name(in_path.name[:-len(".md")] + ".notes.md")
    else:
        out_path = in_path.with_suffix(".notes.md")

    model_label = args.model or "default"
    print(f"generating notes via `{cli}` ({model_label})...", file=sys.stderr)

    notes = call_cli(cli, build_prompt(transcript), args.model)
    out_path.write_text(notes, encoding="utf-8")

    print(f"\n✓ notes: {out_path}", file=sys.stderr)
    print(out_path)


if __name__ == "__main__":
    main()
