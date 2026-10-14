/** Fixed local guidance only. Never render helper stderr, paths, or server text. */
const guidance = Object.freeze({
  CAPTION_UNAVAILABLE: '尚未配置可用字幕助手。开发模式请显式选择已有可信 Python 的绝对路径。',
  CAPTION_CONFIGURATION: 'COCONUT_CAPTION_PYTHON 必须是已有可信 Python 的绝对路径，不能只填 python3 或相对路径。',
  CAPTION_PYTHON_VERSION: '指定 Python 低于 3.10，无法使用固定字幕依赖。请选择已有可信 Python 3.10+ 的绝对路径，使用它重新创建独立环境；不要在旧解释器中反复安装。',
  CAPTION_START: '指定 Python 无法启动。请核对绝对路径、文件是否存在及执行权限，再手动重启。',
  CAPTION_MISSING_YT_DLP: '指定 Python 缺少 yt-dlp。请确认该解释器为 Python 3.10+，再在同一个解释器环境中手动安装 yt-dlp==2026.8.19，或选择已有兼容环境。',
  CAPTION_MISSING_CERTIFI: '指定 Python 缺少 certifi（TLS 证书包）。请确认该解释器为 Python 3.10+，再在同一个解释器环境中手动安装 certifi==2026.7.22，或选择已有兼容环境。',
  CAPTION_MISSING_DEPENDENCIES: '指定 Python 缺少 yt-dlp 和 certifi。请确认该解释器为 Python 3.10+，再在同一个解释器环境中手动安装 yt-dlp==2026.8.19 certifi==2026.7.22，或选择已有兼容环境。',
  CAPTION_VERSION: '依赖版本、TLS 或助手协议不匹配。请确认指定环境使用 yt-dlp==2026.8.19 和可用 certifi，并使用同一份源码重启。',
  CAPTION_EXIT: '指定 Python 已启动，但依赖导入或助手检查未完成。包可能不兼容或损坏；请按开发字幕文档检查同一解释器环境。',
  CAPTION_TIMEOUT: '字幕助手启动检查超时。请检查指定解释器环境；本次没有验证就绪，不会自动重试。',
});
export function captionSetupGuidance(code, diagnostic) {
  const detail = Object.hasOwn(guidance, code) ? guidance[code] : '字幕助手检查未通过。请按开发字幕文档检查指定解释器环境。';
  const version = code === 'CAPTION_VERSION' && diagnostic?.actualVersion && /^\d{4}\.\d{1,2}\.\d{1,2}$/.test(diagnostic.actualVersion)
    ? `当前 yt-dlp=${diagnostic.actualVersion}；需要 2026.08.19。` : '';
  let commands = '';
  if(code === 'CAPTION_UNAVAILABLE') commands = '\n先运行 python3 --version，确认是 Python 3.10+；否则先选择已有可信 Python 3.10+ 的绝对路径替换 python3。\n手动创建独立环境（仓库根目录）：python3 -m venv .venv-captions\n手动安装锁定依赖：.venv-captions/bin/python -m pip install --require-hashes --only-binary=:all: --no-deps -r desktop/development-caption-requirements.txt\n启用：COCONUT_CAPTION_PYTHON="$PWD/.venv-captions/bin/python" npm run dev';
  else if(['CAPTION_MISSING_YT_DLP','CAPTION_MISSING_CERTIFI','CAPTION_MISSING_DEPENDENCIES','CAPTION_VERSION'].includes(code)) commands = '\n手动安装命令（将占位路径替换为启动时指定的同一 Python）："/absolute/path/to/venv/bin/python" -m pip install --require-hashes --only-binary=:all: --no-deps -r desktop/development-caption-requirements.txt';
  return `${version}${detail} 可继续导入或粘贴字幕。详见 docs/development-captions.md；不会自动安装依赖。${commands}`;
}
export const CAPTION_START_GUIDANCE = '字幕启动：COCONUT_CAPTION_PYTHON=/absolute/path/to/venv/bin/python npm run dev。先确认并手动停止占用端口的旧服务；修改环境后需手动重启，再运行 npm run doctor。';
