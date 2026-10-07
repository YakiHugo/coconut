# Build only with scripts/build_caption_helper.py in its clean, pinned environment.
from pathlib import Path
import json
import os
import sys
import sysconfig

root = Path(SPECPATH).resolve().parents[1]
helper = root / 'desktop' / 'helper'
excludes = ['mutagen','curl_cffi','yt_dlp_ejs','websockets','requests','urllib3','Cryptodome','Crypto',
            'brotli','brotlicffi','secretstorage','keyring','deno','sqlite3','_sqlite3','readline',
            'tkinter','_tkinter','curses','_curses','_curses_panel','lzma','_lzma','decimal','_decimal','compression.zstd','_zstd',
            'pip','setuptools','pkg_resources','packaging','numpy','IPython','pytest','ytdlp_plugins']
a = Analysis([str(helper / 'caption_helper_launcher.py')], pathex=[str(root),str(helper)],
             binaries=[],datas=[],hiddenimports=['scripts.public_x_caption_guard','certifi'],
             hookspath=[str(helper / 'hooks')],excludes=excludes,noarchive=False)
# Package-name inventory is a failing gate, not a claim inferred from pip freeze.
allowed = set(sys.stdlib_module_names) | {'yt_dlp','certifi','scripts','subtitle_import','transcript',
           'caption_helper_launcher','_pyi_rth_utils','pyimod01_archive','pyimod02_importers',
           'pyimod03_ctypes','pyimod04_pywin32','pyiboot01_bootstrap','pyi_rth_inspect','pyi_rth_multiprocessing','pyi_rth_pkgutil'}
allowed.add(sysconfig._get_sysconfigdata_name())
unexpected = sorted({name.split('.')[0] for name,_,kind in a.pure if name.split('.')[0] not in allowed})
if unexpected:
    raise RuntimeError('Unreviewed helper Python modules: ' + ', '.join(unexpected))
for name,source,kind in [*a.pure,*a.binaries]:
    if name.split('.')[0] in set(excludes):
        raise RuntimeError('Excluded optional dependency reached bundle: ' + name)
# Persist real input hashes and validated archive aliases as distinct records.
# macOS framework SYMLINK targets are not host filesystem paths.
sys.path.insert(0,str(root))
from scripts.build_caption_helper import analysis_record, validated_framework_link
archive_names = {name for name,_,_ in [*a.binaries,*a.datas]}
for name,source,kind in [*a.binaries,*a.datas]:
    if kind == 'SYMLINK': validated_framework_link(name,source,archive_names)
inventory = {'pure':[analysis_record(n,s,k,archive_names,'sourceSha256') for n,s,k in a.pure],
             'binaries':[{'name':n,'source':s,'kind':k} for n,s,k in a.binaries],
             'scripts':[analysis_record(n,s,k,archive_names,'sourceSha256') for n,s,k in a.scripts],
             'data':[analysis_record(n,s,k,archive_names) for n,s,k in a.datas], 'excluded':excludes}
Path(os.environ['COCONUT_HELPER_INVENTORY']).write_text(json.dumps(inventory,indent=2)+'\n')
pyz = PYZ(a.pure)
exe = EXE(pyz,a.scripts,a.binaries,a.datas,[],name='coconut-caption',debug=False,
          bootloader_ignore_signals=False,strip=False,upx=False,console=True,
          disable_windowed_traceback=True,argv_emulation=False,target_arch=None,
          codesign_identity=None,entitlements_file=None)
