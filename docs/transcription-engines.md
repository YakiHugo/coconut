# 转录服务的本地引擎

`pnpm start` 使用同一个转录服务入口、Node 任务队列、取消机制与结果存储。部署时通过 `COCONUT_ASR_BACKEND` 选择完整引擎方案；默认仍为 `qwen-mlx`。阅读器与来源导入界面不新增模型选择步骤。

| 配置值 | 本地方案 | 时间与人物输出 |
|---|---|---|
| `qwen-mlx`（默认） | Qwen3-ASR-1.7B-8bit＋Qwen3-ForcedAligner-0.6B-8bit；可配置 Sherpa 声学分组 | 字词对齐可用时保留字词时间；配置声学模型后提供录音内人物分组。缺少完整字词对齐时明确降为句段时间 |
| `moss-mlx` | MOSS-Transcribe-Diarize-MLX-8bit 联合转录 | 原生句段文字、起止时间与匿名人物编号；不额外调用 Qwen 对齐器或 Sherpa，不生成伪造字词时间 |
| `faster-whisper` | 已准备的 faster-whisper small CPU 模型 | 保留原有显式备用方案；不会因其他引擎不可用而自动启用 |

各方案的能力与质量分别验证。可用性检查只检查本地环境与模型文件，不能当作推理成功或准确率保证。

## 保持默认 Qwen

准备好 Python 环境与模型后，在本地 `.env` 中配置：

```dotenv
COCONUT_ASR_PYTHON=/absolute/path/to/prepared/python
COCONUT_ASR_BACKEND=qwen-mlx
COCONUT_ASR_MODEL=/absolute/path/to/Qwen3-ASR-1.7B-8bit
COCONUT_ALIGN_MODEL=/absolute/path/to/Qwen3-ForcedAligner-0.6B-8bit
```

可以同时配置 `COCONUT_SPEAKER_SEGMENTATION_MODEL` 和 `COCONUT_SPEAKER_EMBEDDING_MODEL` 以启用 Qwen 的独立声学人物处理。两份声学模型需一起准备，相关规则见[现有流程](transcription-pipeline.md)。

未指定模型路径时，从 `COCONUT_MODEL_DIRECTORY` 指定的绝对目录查找默认模型；该变量为空时使用 `~/.coconut/models`。

## 选择 MOSS

使用已安装 `mlx-audio`、MLX、PyAV 等依赖的 Python，以及完整的本地 MLX 模型目录：

```dotenv
COCONUT_ASR_PYTHON=/absolute/path/to/prepared/python
COCONUT_ASR_BACKEND=moss-mlx
COCONUT_ASR_MODEL=/absolute/path/to/MOSS-Transcribe-Diarize-MLX-8bit
```

MOSS 默认目录为 `<COCONUT_MODEL_DIRECTORY>/MOSS-Transcribe-Diarize-MLX-8bit`；未设置模型根目录时为 `~/.coconut/models/MOSS-Transcribe-Diarize-MLX-8bit`。`COCONUT_ASR_MODEL` 允许显式覆盖，必须是绝对本地路径。

MOSS 配置会排除 `COCONUT_ALIGN_MODEL` 与两个 `COCONUT_SPEAKER_*` 路径。这些遗留设置不会变成 MOSS 的依赖，也不参与其任务配置身份。MOSS 本身缺少环境或模型文件时会明确不可用；不会下载模型、换到 Qwen、调用远程转录或静默补上对齐。

服务启动后读取配置。切换后重启服务，并为新配置创建转录任务。已有任务绑定原音频及引擎配置，不能借重试把旧任务转换为另一套引擎；已有稿件仍可阅读。来源元数据提取、人物显示名与可选全文校对属于服务的后续步骤，是否启用继续由相应配置决定。

## MOSS 的长音频与人物范围

MOSS 方案采用不重叠的有界音频块，每块最多30分钟。各块原生非空文字与句段时间全部保留，统一还原为整集音频坐标；不使用“重叠上下文＋整句中点归属”的实验拼接规则，不在缺乏逐字证据时裁切文字。无重叠可避免该归属规则造成的双弃／双留，但硬切音频仍可能影响边界附近的识别，需要回听验证。

人物编号带范围信息。单块音频可在该录音范围使用原生人物组；多块录音的人物编号只在各自块内有效，不能把相邻块的 `S01` 当成同一人。真实姓名映射与跨块声纹身份是不同证据，不应因显示名相同就推断声学身份已合并。

MOSS 仅提供原生句段时间，本方案不承诺逐字高亮。整集无文字、输出截断、非法时间或某块执行失败时，不把部分结果包装成整集完成；已提交的原始检查点用于同一配置的明确重试。单块空输出会保留原始记录并标记 `empty_output`，允许静音等没有文字的片段，但不能仅凭空输出断言该块没有语音。任务完成表示各块执行成功，不证明全部语音都被识别。源音频、模型内容、运行时、提示和切块设置参与缓存身份，变化后拒绝误用旧结果。

## 模型升级与服务边界

后端输出通过统一文档格式进入现有服务，能力字段保留原生时间粒度与人物范围。原始识别、后续校对和阅读版本分别保存；新模型不需要伪装成经过与旧模型相同的内部步骤。

升级时先用固定样本检查文字、时间、人物覆盖、耗时与内存，再调整部署配置。引擎选择不会主动更新依赖或拉取模型，运行时始终读取已经准备的本地文件。
