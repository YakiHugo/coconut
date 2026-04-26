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

## 核心能力（v0.1，已可用）

```
URL → yt-dlp 下载 → WhisperX 转录 + 说话人识别 → Claude 润色 → Markdown
```

支持平台：YouTube、Bilibili 及 yt-dlp 支持的 1000+ 平台。

- ✅ **下载音频**：`yt-dlp` 处理 YouTube / B 站
- ✅ **高质量转录**：WhisperX + `large-v3`，中文优化
- ✅ **说话人识别**：pyannote 自动分离对话双方
- ✅ **去碎嘴**：Claude 自动清理"嗯/呃/那个/就是"，修语病、合断句、加段落
- ✅ **认人**：Claude 从上下文推断真实姓名替换 `SPEAKER_00`

## Roadmap

| 阶段 | 功能 | 状态 |
|------|------|------|
| v0.1 | CLI：URL → 干净的 Markdown 文稿 | ✅ 当前 |
| v0.2 | 时间戳保留 + 行级跳转回原视频对应位置 | 计划 |
| v0.3 | Web UI：阅读、搜索、高亮、批注 | 计划 |
| v0.4 | 概念扩展：选中文字 → Claude 自动深挖背景知识 | 计划 |
| v0.5 | 订阅 & 定时：关注播客频道，新集自动转录入库 | 计划 |
| v0.6 | 全文搜索 + 跨集知识图谱 | 探索 |

## 安装（macOS / Apple Silicon）

```bash
git clone https://github.com/YakiHugo/coconut.git
cd coconut
./install.sh
export PATH="$PWD:$PATH"        # 写到 ~/.zshrc 持久化
```

依赖：`ffmpeg`、`yt-dlp`、Python 3.11、`whisperx`、`anthropic`。首次运行会再下一个 ~3GB 的 Whisper large-v3 模型。

## 配置（可选但推荐）

### 说话人识别（HF_TOKEN）

不设就只能拿到没人名的文稿。开启：

1. 注册 https://huggingface.co
2. 在 https://huggingface.co/pyannote/speaker-diarization-3.1 同意许可
3. 在 https://huggingface.co/settings/tokens 生成 **Read** token
4. `export HF_TOKEN=hf_xxxxx`

### Claude 润色（ANTHROPIC_API_KEY）

```bash
export ANTHROPIC_API_KEY=sk-ant-xxxxx
```

不设的话脚本只输出原始稿，你直接拖进 Claude Code 让它润色——`polish.py` 里的提示词可以直接复用。

## 用法

```bash
pt https://www.bilibili.com/video/BVxxxxx           # 一条命令搞定
pt https://www.youtube.com/watch?v=xxx ./out        # 指定输出目录

./transcribe.py <url>                               # 只转录
./polish.py transcript.raw.md                       # 只润色
```

输出：
- `<id>.raw.md` — WhisperX 原始转录（带 `SPEAKER_xx` 标签）
- `<id>.md`     — Claude 润色后的最终稿

## 性能参考（M5 Pro 48GB）

| 1 小时音频 | 时长 |
|-----------|------|
| 下载 | ~30 秒 |
| 转录（large-v3） | ~8-12 分钟 |
| 说话人识别 | ~2-3 分钟 |
| Claude 润色（Sonnet 4.6） | ~30-60 秒，约 $0.05-0.10 |

## 调整

- **更快/更省内存**：`transcribe.py` 中 `large-v3` → `medium`（中文也很好，2-3x 速度）
- **更便宜的润色**：`--model` → `claude-haiku-4-5-20251001`
- **B 站报错**：`brew upgrade yt-dlp`（B 站常变 API）

## 贡献

这是一个长期项目。欢迎 issue 和 PR，特别是：
- B 站、小宇宙等中文平台的下载优化
- 中文播客转录的提示词调优
- v0.2+ 的功能设计讨论

## License

MIT
