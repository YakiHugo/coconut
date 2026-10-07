#!/usr/bin/env python3
"""Build a no-extras native helper in an already-created hash-pinned venv.

macOS output is eligible for packaging only after inventory and notice gates.
Linux output is local/CI proof only and is never a release asset.
"""
from __future__ import annotations
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import ssl
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / 'desktop'
LOCK = json.loads((DESKTOP / 'caption-helper-lock.json').read_text())
ARCH = {'x86_64':'x64','AMD64':'x64','aarch64':'arm64','arm64':'arm64'}.get(platform.machine())
TARGET = f'{sys.platform}-{ARCH}'


def digest(data): return hashlib.sha256(data).hexdigest()

def download_source(record, destination):
    """Exact source artifacts are retained next to the helper; never executed."""
    if not record['url'].startswith('https://files.pythonhosted.org/packages/'):
        raise RuntimeError('Unexpected source artifact host')
    with urllib.request.urlopen(record['url'], timeout=40) as response:
        body = response.read(record['bytes'] + 1)
    if len(body) != record['bytes'] or digest(body) != record['sha256']:
        raise RuntimeError('Source artifact integrity failure')
    destination.write_bytes(body)


def audit_native(inventory):
    """No opaque third-party dylib can silently become redistributable."""
    output=[]
    for item in inventory['binaries']:
        source=Path(item['source'])
        if not source.is_file(): raise RuntimeError('Missing analyzed native input')
        record={'name':item['name'],'kind':item['kind'],'sha256':digest(source.read_bytes())}
        if sys.platform=='darwin':
            name=source.name
            if item['kind']=='EXTENSION':
                module=name.split('.')[0]
                if module not in sys.stdlib_module_names:
                    raise RuntimeError('Unreviewed third-party native extension: '+name)
            elif name not in {'Python','libpython3.14.dylib','libssl.3.dylib','libcrypto.3.dylib'}:
                raise RuntimeError('Unreviewed bundled native library: '+name)
            links=subprocess.check_output(['/usr/bin/otool','-L',str(source)],text=True)
            dependencies=[line.strip().split(' (',1)[0] for line in links.splitlines()[1:] if line.strip() and not line.endswith(':')]
            for dependency in dependencies:
                if dependency.startswith(('/usr/lib/','/System/Library/','@loader_path/','@rpath/','@executable_path/')):
                    continue
                if Path(dependency).name not in {'Python','libpython3.14.dylib','libssl.3.dylib','libcrypto.3.dylib'}:
                    raise RuntimeError('Unreviewed native load dependency: '+dependency)
            record['dependencies']=dependencies
        output.append(record)
    return output


def main():
    if ARCH not in ('x64','arm64') or sys.platform not in ('darwin','linux'):
        raise RuntimeError('Unsupported helper build host')
    python_version=platform.python_version()
    if sys.platform=='darwin' and python_version!=LOCK['python']:
        raise RuntimeError('macOS helper must use the exact pinned Python version')
    if sys.platform=='darwin' and not ssl.OPENSSL_VERSION.startswith('OpenSSL 3.5.9 '):
        raise RuntimeError('Unreviewed OpenSSL runtime; update source and notice inventory first')
    # Running the build in an ambient environment is forbidden, even if its
    # optional installed dependencies would be excluded by the module graph.
    if sys.prefix==sys.base_prefix: raise RuntimeError('Create a fresh private venv first')
    expected={p['name'].lower().replace('_','-'):p['version'] for p in LOCK['packages']}
    installed={d.metadata['Name'].lower().replace('_','-'):d.version for d in importlib.metadata.distributions()}
    expected.pop('macholib',None) if sys.platform!='darwin' else None
    if any(installed.get(name)!=version for name,version in expected.items()) or set(installed)-set(expected)-{'pip'}:
        raise RuntimeError('Helper build environment differs from the pinned no-extras inventory')
    output=DESKTOP/'helper-build'/TARGET
    if output.exists(): shutil.rmtree(output)
    output.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='coconut-helper-build-') as work:
        work=Path(work);env=dict(os.environ)
        env['COCONUT_HELPER_INVENTORY']=str(work/'inventory.json')
        env['PYTHONNOUSERSITE']='1'
        for key in ('PYTHONPATH','PYTHONSTARTUP','PYTHONHOME'):env.pop(key,None)
        subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--clean','--distpath',str(work/'dist'),
                        '--workpath',str(work/'build'),str(DESKTOP/'helper'/'coconut-caption.spec')],env=env,check=True)
        inventory=json.loads((work/'inventory.json').read_text())
        inventory['binaries']=audit_native(inventory)
        binary=work/'dist'/'coconut-caption';data=binary.read_bytes()
        if not 0<len(data)<=80*1024*1024:raise RuntimeError('Unexpected native helper size')
        shutil.copyfile(binary,output/'coconut-caption');(output/'coconut-caption').chmod(0o500)
        notices=DESKTOP/'vendor'/'caption-helper-notices'
        if not notices.is_dir():raise RuntimeError('Helper licensing notices are missing')
        shutil.copytree(notices,output/'notices')
        sources=output/'sources';sources.mkdir()
        # Exact source for the only shipped third-party Python packages, including
        # certifi's MPL-covered data; build tool source URLs/hashes are in the lock.
        for package in LOCK['packages']:
            if package['name'] in ('yt-dlp','certifi'):
                record=next(f for f in package['files'] if f['type']=='sdist')
                download_source(record,sources/record['filename'])
        for source in [DESKTOP/'helper'/'caption_helper_launcher.py',DESKTOP/'helper'/'coconut-caption.spec',
                       Path(__file__),ROOT/'scripts'/'public_x_caption_guard.py',ROOT/'subtitle_import.py',ROOT/'transcript.py']:
            shutil.copyfile(source,sources/source.name)
        shutil.copyfile(DESKTOP/'helper'/'hooks'/'hook-yt_dlp.py',sources/'hook-yt_dlp.py')
        shutil.copyfile(ROOT/'LICENSE',sources/'LICENSE.coconut')
        shutil.copyfile(DESKTOP/'caption-helper-lock.json',sources/'caption-helper-lock.json')
        shutil.copyfile(DESKTOP/'caption-helper-requirements.txt',sources/'caption-helper-requirements.txt')
        (output/'notices'/'bundle-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
        receipt={'schemaVersion':1,'name':'coconut-caption','platform':sys.platform,'arch':ARCH,'protocol':1,
                 'ytDlpVersion':LOCK['ytDlpVersion'],'python':python_version,'pyinstaller':LOCK['pyinstaller'],
                 'bytes':len(data),'sha256':digest(data),'lockSha256':digest((DESKTOP/'caption-helper-lock.json').read_bytes()),
                 'distribution':'minimal-permissive-with-certifi-source' if sys.platform=='darwin' else 'ci-proof-only',
                 'publicExtraction':True}
        (output/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'target':TARGET,'receipt':str(output/'receipt.json'),'bytes':receipt['bytes'],'sha256':receipt['sha256']}))


if __name__=='__main__': main()
