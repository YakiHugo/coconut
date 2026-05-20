# 🥥 coconut

> Crack open podcasts. Turn talk into text you can actually study.

**coconut** 把没有文字稿的播客和视频转化为**带时间戳、结构化、可深读**的中文文字稿，让你能像读论文一样反复学习播客、对不懂的概念用 AI 深挖、一键回到视频源对应位置。

---

## 为什么做这个

很多优质的播客和讲座视频根本没有文字稿——你听到一个有意思的概念，想停下来查、想做笔记、想日后回看，全靠耳朵和记忆。这导致：

- ❌ 听过即忘，难以复习
- ❌ 想针对一个具体观点深入研究，找不到原话
- ❌ 想引用一段话，没法精确定位
- ❌ 一个小时的内容，没法 5 分钟扫完核心

coconut 的目标是把"听"升维到"读 + 研"。

## 核心能力（v0.2，已可用）

```
URL 或本地文件 → 转录（带时间戳 + 说话人）→ 润色 + 跳转链接 → AI 笔记
```

支持来源：YouTube、Bilibili 及 yt-dlp 支持的 1000+ 平台；以及任意本地音频/视频文件。

- ✅ **下载或读本地文件**：URL 走 `yt-dlp`；本地文件走 `ffmpeg`
- ✅ **高质量转录**：WhisperX + `large-v3`，中文优化
- ✅ **说话人识别**：pyannote 自动分离对话双方
- ✅ **段级时间戳**：每段开头标注 `[HH:MM:SS]`，原始稿与润色稿都保留
- ✅ **跳转链接**：URL 来源会把时间戳变成可点链接，一秒跳回视频对应位置
- ✅ **去碎嘴**：Claude 自动清理"嗯/呃/那个/就是"，修语病、合断句、加段落
- ✅ **认人**：Claude 从上下文推断真实姓名替换 `SPEAKER_00`
- ✅ **AI 笔记**：自动产出 TL;DR、章节大纲、关键观点、金句摘录

## Roadmap

| 阶段 | 功能 | 状态 |
|------|------|------|
| v0.1 | CLI：URL → 干净的 Markdown 文稿 | ✅ |
| v0.2 | 时间戳保留 + 跳转链接 + 本地文件输入 + AI 笔记 | ✅ 当前 |
| v0.3 | Web UI：阅读、搜索、高亮、批注 | 计划 |
| v0.4 | 概念扩展 + 全文问答：选中文字 → Claude 深挖 / 问 | 计划 |
| v0.5 | 订阅 & 定时：关注播客频道，新集自动转录入库 | 计划 |
| v0.6 | 全文搜索 + 跨集知识图谱 | 探索 |

## 安装（macOS / Linux）

```bash
git clone https://github.com/YakiHugo/coconut.git
cd coconut
./install.sh
export PATH="$PWD:$PATH"        # 写到 ~/.zshrc 或 ~/.bashrc 持久化
```

依赖：`ffmpeg`、`yt-dlp`、Python 3.11、`whisperx`。润色阶段调用本地的 `claude` 或 `codex` CLI，不再需要 API key。首次运行会再下一个 ~3GB 的 Whisper large-v3 模型。

## 配置（可选但推荐）

### 说话人识别（HF_TOKEN）

不设就只能拿到没人名的文稿。开启：

1. 注册 https://huggingface.co
2. 在 https://huggingface.co/pyannote/speaker-diarization-3.1 同意许可
3. 在 https://huggingface.co/settings/tokens 生成 **Read** token
4. `export HF_TOKEN=hf_xxxxx`

> 这个 token **只用于本地下载 / 加载 pyannote 权重**，不会把你的音频上传到任何地方。

### 自动润色（claude / codex CLI）

`polish.py` 调用本地已登录的 [`claude`](https://docs.claude.com/en/docs/claude-code) 或 [`codex`](https://github.com/openai/codex) CLI 的 headless 模式（`claude -p` / `codex exec`）来跑润色。**复用你的订阅，不用配 API key、不另外计费**。

```bash
# 装其中之一（推荐 claude），跑一次交互式确保已登录
claude    # 或 codex
```

`pt` 检测到任意一个 CLI 在 PATH 上就会自动润色；都没有就只输出原始稿，你可以自己拖进 Claude / ChatGPT 让它润色——`polish.py` 里的提示词可以直接复用。

## 用法

```bash
pt https://www.bilibili.com/video/BVxxxxx           # URL：一条命令跑完三步
pt https://www.youtube.com/watch?v=xxx ./out        # 指定输出目录
pt ./录音.m4a                                        # 本地音频/视频文件同样支持

./transcribe.py <url-or-file>                       # 只转录
./polish.py transcript.raw.md                       # 只润色
./notes.py transcript.md                            # 只生成 AI 笔记
```

输出：
- `<标题>.raw.md`   — WhisperX 原始转录（带时间戳 + `SPEAKER_xx` 标签）
- `<标题>.md`       — 润色后的最终稿（URL 来源时时间戳是可点击的跳转链接）
- `<标题>.notes.md` — TL;DR + 章节大纲 + 关键观点 + 金句

文件名取自视频标题或本地文件名（特殊字符替换为 `_`，最长 80 字符），标题获取失败时回退到视频 ID。同一个来源重复跑会自动跳过已完成的步骤；想强制重新转录用 `transcribe.py <url-or-file> --force`。

## 性能参考（M5 Pro 48GB）

| 1 小时音频 | 时长 |
|-----------|------|
| 下载 | ~30 秒 |
| 转录（large-v3） | ~8-12 分钟 |
| 说话人识别 | ~2-3 分钟 |
| 润色（本地 claude CLI） | ~30-60 秒，按你的订阅计 |

## 调整

- **更快/更省内存**：`transcribe.py` 中 `large-v3` → `medium`（中文也很好，2-3x 速度）
- **指定润色/笔记模型**：`polish.py xxx.raw.md --model <model-id>`、`notes.py xxx.md --model <model-id>`（透传给 CLI）
- **指定润色/笔记 CLI**：`--cli claude` 或 `--cli codex`
- **不要跳转链接**：润色稿默认在 URL 来源时嵌入跳转链接；如果不想要，在 `<标题>.raw.md` 顶部删掉 `<!-- source: ... -->` 注释那一行后再跑 `polish.py`
- **B 站报错**：`brew upgrade yt-dlp`（B 站常变 API）

## 贡献

这是一个长期项目。欢迎 issue 和 PR，特别是：
- B 站、小宇宙等中文平台的下载优化
- 中文播客转录的提示词调优
- v0.2+ 的功能设计讨论

## License

MIT
