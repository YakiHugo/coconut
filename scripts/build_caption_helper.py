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
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / 'desktop'
LOCK = json.loads((DESKTOP / 'caption-helper-lock.json').read_text())
ARCH = {'x86_64':'x64','AMD64':'x64','aarch64':'arm64','arm64':'arm64'}.get(platform.machine())
TARGET = f'{sys.platform}-{ARCH}'


def digest(data): return hashlib.sha256(data).hexdigest()

INPUT_FILES = ['desktop/caption-helper-lock.json','desktop/caption-helper-requirements.txt',
               'desktop/helper/caption_helper_launcher.py','desktop/helper/coconut-caption.spec',
               'desktop/helper/hooks/hook-yt_dlp.py','scripts/build_caption_helper.py',
               'scripts/public_x_caption_guard.py','subtitle_import.py','transcript.py','LICENSE']

def input_hashes():
    files=[ROOT/name for name in INPUT_FILES]
    files += sorted((DESKTOP/'vendor'/'caption-helper-notices').rglob('*'))
    result={}
    for file in files:
        if file.is_symlink():raise RuntimeError('Build input may not be a symlink')
        if file.is_file():result[str(file.relative_to(ROOT))]=digest(file.read_bytes())
    return result


def resource_hashes(output):
    return {str(file.relative_to(output)):digest(file.read_bytes()) for file in sorted(output.rglob('*')) if file.is_file()}


def approved_python_inputs():
    metadata=json.loads((DESKTOP/'vendor'/'caption-helper-notices'/'python-runtime-input.json').read_text())
    framework=Path(metadata['nativeInputVerification']['frameworkRoot']).resolve()
    interpreter=Path(sys._base_executable).resolve()
    if not interpreter.is_relative_to(framework):raise RuntimeError('Python is not the approved official framework distribution')
    expected=metadata['expectedInterpreterInputs'].get(str(interpreter.relative_to(framework)))
    if not expected or interpreter.stat().st_size!=expected['bytes'] or digest(interpreter.read_bytes())!=expected['sha256']:
        raise RuntimeError('Exact Python interpreter input differs from approved installer')
    return framework,metadata['expectedNativeInputs']

def download_source(record, destination):
    """Exact source artifacts are retained next to the helper; never executed."""
    if not record['url'].startswith('https://files.pythonhosted.org/packages/'):
        raise RuntimeError('Unexpected source artifact host')
    with urllib.request.urlopen(record['url'], timeout=40) as response:
        body = response.read(record['bytes'] + 1)
    if len(body) != record['bytes'] or digest(body) != record['sha256']:
        raise RuntimeError('Source artifact integrity failure')
    destination.write_bytes(body)


def verify_certifi_source():
    import certifi
    root=Path(certifi.__file__).resolve().parent
    archive=DESKTOP/'vendor'/'caption-helper-notices'/'sources'/'certifi-2026.7.22.tar.gz'
    with tarfile.open(archive) as source:
        for name in ['__init__.py','__main__.py','core.py','cacert.pem']:
            expected=source.extractfile('certifi-2026.7.22/certifi/'+name).read()
            if (root/name).read_bytes()!=expected:
                raise RuntimeError('Installed certifi differs from delivered MPL source: '+name)


# PyInstaller reconstructs these standard Python.framework aliases. SYMLINK
# sources are archive-relative target strings, never paths to files to hash.
FRAMEWORK_LINKS = {
    'Python': ('Python.framework/Versions/3.14/Python', 'Python.framework/Versions/3.14/Python'),
    'Python.framework/Python': ('Versions/Current/Python', 'Python.framework/Versions/3.14/Python'),
    'Python.framework/Resources': ('Versions/Current/Resources', 'Python.framework/Versions/3.14/Resources'),
    'Python.framework/Versions/Current': ('3.14', 'Python.framework/Versions/3.14'),
}

def validated_framework_link(name, target, archive_names):
    expected = FRAMEWORK_LINKS.get(name)
    if not expected or target != expected[0]:
        raise RuntimeError('Unapproved framework symlink: '+name)
    canonical = expected[1]
    if not any(entry == canonical or entry.startswith(canonical+'/') for entry in archive_names):
        raise RuntimeError('Framework symlink target is absent from archive: '+name)
    return {'name':name,'kind':'SYMLINK','target':target,'resolvedArchivePath':canonical}


def analysis_record(name, source, kind, archive_names, hash_key='sha256'):
    if kind == 'SYMLINK':
        return validated_framework_link(name, source, archive_names)
    if source == '-':
        if name != 'scripts' or kind != 'PYMODULE':
            raise RuntimeError('Unapproved namespace analysis record: '+name)
        return {'name':name,'kind':kind,hash_key:'namespace-package'}
    # Every real code/data input remains hashed; an unexpected missing source
    # fails rather than being mistaken for a symbolic-link target.
    return {'name':name,'kind':kind,hash_key:digest(Path(source).read_bytes())}


def expand_macho_path(value, native, executable):
    if value == '@loader_path': return native.parent
    if value.startswith('@loader_path/'): return native.parent/value.removeprefix('@loader_path/')
    if value == '@executable_path': return executable.parent
    if value.startswith('@executable_path/'): return executable.parent/value.removeprefix('@executable_path/')
    return Path(value)


def audit_frozen(binary, directory):
    from PyInstaller.archive.readers import CArchiveReader
    # macOS temp paths commonly enter through /var -> /private/var. Compare
    # resolved candidates against one canonical root, preserving containment.
    binary=binary.resolve()
    archive=CArchiveReader(str(binary));root=directory/'frozen-audit';root.mkdir();root=root.resolve()
    natives=[];symlinks=[]
    for name,entry in archive.toc.items():
        if entry[-1] not in ('b','n'):continue
        destination=root/name
        if Path(name).is_absolute() or '..' in Path(name).parts:raise RuntimeError('Unsafe frozen archive path')
        destination.parent.mkdir(parents=True,exist_ok=True)
        payload=archive.extract(name)
        if entry[-1]=='n':
            target=payload.rstrip(b'\0').decode('utf8')
            validated_framework_link(name,target,archive.toc)
            symlinks.append((destination,target))
        else:destination.write_bytes(payload);natives.append(destination)
    for destination,target in symlinks:
        if Path(target).is_absolute() or not (destination.parent/target).resolve().is_relative_to(root):raise RuntimeError('Unsafe frozen symlink')
        destination.symlink_to(target)
    records=[]
    for native in [binary,*natives]:
        record={'name':native.name if native==binary else str(native.relative_to(root)),'sha256':digest(native.read_bytes())}
        if sys.platform=='darwin':
            architectures=subprocess.check_output(['/usr/bin/lipo','-archs',str(native)],text=True).split()
            if architectures!=[{'arm64':'arm64','x64':'x86_64'}[ARCH]]:raise RuntimeError('Unexpected frozen architecture')
            record['architectures']=architectures
            links=subprocess.check_output(['/usr/bin/otool','-L',str(native)],text=True)
            deps=[line.strip().split(' (',1)[0] for line in links.splitlines()[1:] if line.strip() and not line.endswith(':')]
            install_ids=subprocess.run(['/usr/bin/otool','-D',str(native)],capture_output=True,text=True,check=False).stdout.splitlines()[1:]
            load_commands=subprocess.check_output(['/usr/bin/otool','-l',str(native)],text=True).splitlines()
            rpaths=[]
            for i,line in enumerate(load_commands):
                if line.strip()=='cmd LC_RPATH':
                    for field in load_commands[i+1:i+5]:
                        if field.strip().startswith('path '):rpaths.append(field.strip()[5:].split(' (offset',1)[0])
            for dependency in deps:
                if dependency in install_ids or dependency.startswith(('/usr/lib/','/System/Library/')):continue
                candidates=[expand_macho_path(dependency,native,binary)]
                if dependency.startswith('@rpath/'):
                    candidates=[expand_macho_path(rpath,native,binary)/dependency.removeprefix('@rpath/') for rpath in rpaths]
                if not any(candidate.resolve().is_relative_to(root) and candidate.is_file() for candidate in candidates):
                    raise RuntimeError('Unresolved/absolute non-system frozen dependency: '+dependency)
            record['dependencies']=deps
        records.append(record)
    return records


def audit_native(inventory):
    """No opaque third-party dylib can silently become redistributable."""
    output=[]
    framework,expected_inputs=approved_python_inputs() if sys.platform=='darwin' else (None,None)
    for item in inventory['binaries']:
        if item['kind']=='SYMLINK':
            output.append(validated_framework_link(item['name'],item['source'],{entry['name'] for category in ('binaries','data') for entry in inventory[category]}));continue
        source=Path(item['source'])
        if not source.is_file(): raise RuntimeError('Missing analyzed native input')
        record={'name':item['name'],'kind':item['kind'],'sha256':digest(source.read_bytes())}
        if sys.platform=='darwin':
            source=source.resolve()
            if not source.is_relative_to(framework):raise RuntimeError('Native input is outside approved Python distribution')
            relative=str(source.relative_to(framework));approved=expected_inputs.get(relative)
            if not approved or source.stat().st_size!=approved['bytes'] or digest(source.read_bytes())!=approved['sha256']:
                raise RuntimeError('Exact native input differs from approved installer: '+relative)
            record['component']=approved['component'];record['inputRelativePath']=relative
            name=source.name
            if name.split('.')[0] in {'_sqlite3','_decimal','_lzma','_zstd','_tkinter','readline'}:
                raise RuntimeError('Excluded static native library reached bundle: '+name)
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
    if sys.platform=='darwin':approved_python_inputs()
    verify_certifi_source()
    source_inputs=input_hashes()
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
        inventory['frozenNative']=audit_frozen(binary,work)
        if not 0<len(data)<=80*1024*1024:raise RuntimeError('Unexpected native helper size')
        shutil.copyfile(binary,output/'coconut-caption');(output/'coconut-caption').chmod(0o500)
        notices=DESKTOP/'vendor'/'caption-helper-notices'
        if not notices.is_dir():raise RuntimeError('Helper licensing notices are missing')
        notice_index=json.loads((notices/'sources.json').read_text())
        for item in notice_index['files']:
            payload=(notices/item['file']).read_bytes()
            if len(payload)!=item['bytes'] or digest(payload)!=item['sha256']:
                raise RuntimeError('Pinned legal notice/source integrity failure')
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
        if input_hashes()!=source_inputs:raise RuntimeError('Build inputs changed during freeze')
        receipt={'schemaVersion':1,'name':'coconut-caption','platform':sys.platform,'arch':ARCH,'protocol':1,
                 'ytDlpVersion':LOCK['ytDlpVersion'],'python':python_version,'pyinstaller':LOCK['pyinstaller'],
                 'bytes':len(data),'sha256':digest(data),'lockSha256':digest((DESKTOP/'caption-helper-lock.json').read_bytes()),
                 'distribution':'minimal-permissive-with-certifi-source' if sys.platform=='darwin' else 'ci-proof-only',
                 'publicExtraction':True,'inputs':source_inputs,'resources':resource_hashes(output)}
        (output/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'target':TARGET,'receipt':str(output/'receipt.json'),'bytes':receipt['bytes'],'sha256':receipt['sha256']}))


if __name__=='__main__': main()
