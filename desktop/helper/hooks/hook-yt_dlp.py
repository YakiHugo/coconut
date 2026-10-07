"""No optional downloader, crypto, browser or plugin dependencies in this build."""
from PyInstaller.utils.hooks import collect_submodules
hiddenimports = collect_submodules('yt_dlp', filter=lambda name: not name.startswith(('yt_dlp.__main__', 'yt_dlp.__pyinstaller')))
excludedimports = ['youtube_dl', 'youtube_dlc', 'test', 'ytdlp_plugins', 'devscripts', 'bundle']
