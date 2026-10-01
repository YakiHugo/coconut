#!/usr/bin/env python3
"""Polish a raw transcript with Claude — strip filler words, fix grammar, preserve source anchors and speaker labels."""
import os, sys
_venv = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".venv", "bin", "python3")
if os.path.exists(_venv) and os.path.abspath(sys.executable) != os.path.abspath(_venv):
    os.execv(_venv, [_venv] + sys.argv)

import argparse
import re
import sys
from pathlib import Path



SYSTEM_PROMPT = """你是一名专业的中文播客编辑。用户会给你一段原始的语音转录稿，可能带说话人标签（SPEAKER_00、SPEAKER_01 …）。请把它整理成一份易读的播客文字稿。

要求：

1. **去碎嘴**：删除"嗯""啊""呃""那个""就是""然后""所以说""对吧""是吧"这类无信息量的填充词；保留有意义的语气。
2. **修语病**：把口语化的不通顺表达改成完整流畅的句子；不改变原意。
3. **纠错字**：根据上下文修正语音识别的同音字、专有名词错误。
4. **合断句**：把被时间戳切碎的同一句话合并完整。
5. **加段落**：在话题转换处空行分段。
6. **说话人**：保留原始说话人标签，不根据上下文猜测真实姓名。
7. **时间定位**：完整保留每一个时间戳链接，不能删除、修改、移动或合并时间锚点。
8. **保原意**：只做"读起来更顺"的工作。不总结、不发挥、不省略实质内容、不加任何前言或编辑说明。

输出格式：每位说话人的发言用 `**说话人**：内容` 表示，不同说话人之间空一行。直接输出整理后的稿件本体，不要任何额外说明。"""


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


def validate_polished_chunk(original: str, polished: str) -> None:
    """Reject missing/reordered source links; semantic accuracy still needs review."""
    pattern = r"\[(?:\d{2}:)?\d{2}:\d{2}\]\([^\n]*?\)"
    if re.findall(pattern, original) != re.findall(pattern, polished):
        raise ValueError("Polishing changed source timestamp links; original retained")
    speakers = set(re.findall(r"SPEAKER_\d+", original))
    if not speakers.issubset(set(re.findall(r"SPEAKER_\d+", polished))):
        raise ValueError("Polishing dropped speaker labels; original retained")
    if not polished.strip():
        raise ValueError("Polishing returned empty text")


def polish(raw: str, model: str) -> str:
    from anthropic import Anthropic

    client = Anthropic()
    chunks = chunk_transcript(raw)
    print(f"polishing {len(chunks)} chunk(s) with {model}...", file=sys.stderr)

    out: list[str] = []
    for i, chunk in enumerate(chunks, 1):
        print(f"  [{i}/{len(chunks)}]", file=sys.stderr)
        resp = client.messages.create(
            model=model,
            max_tokens=8192,
            system=[{
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{
                "role": "user",
                "content": f"原文：\n---\n{chunk}\n---",
            }],
        )
        if resp.stop_reason != "end_turn":
            raise ValueError(f"Polishing incomplete ({resp.stop_reason}); original retained")
        text = "\n".join(block.text for block in resp.content if block.type == "text").strip()
        validate_polished_chunk(chunk, text)
        out.append(text)
    return "\n\n".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Raw transcript markdown file")
    parser.add_argument("-o", "--output", help="Output path (default: <input minus .raw>.md)")
    parser.add_argument("--model", default="claude-sonnet-4-6", help="Claude model id")
    args = parser.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("error: ANTHROPIC_API_KEY not set")

    in_path = Path(args.input)
    raw = in_path.read_text(encoding="utf-8")

    polished = polish(raw, model=args.model)

    if args.output:
        out_path = Path(args.output)
    elif in_path.name.endswith(".raw.md"):
        out_path = in_path.with_name(in_path.name[:-len(".raw.md")] + ".md")
    else:
        out_path = in_path.with_suffix(".polished.md")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(polished, encoding="utf-8")
    print(f"\n✓ polished transcript: {out_path}", file=sys.stderr)
    print(out_path)


if __name__ == "__main__":
    main()
