"""Bounded, local-only translation using official Argos CTranslate2 model data.

No paid model API or executable remote model code is used. OPUS preparation
uses optional CPU PyTorch; runtime translation uses CTranslate2.
This legacy offline rough-draft path translates each cue separately. Subtitle
cues are not reliable semantic units; use the contextual CLI workflow when
context, terminology and discourse consistency are required. Each output keeps
its original cue ID; this does not imply translated-word alignment.
"""
from __future__ import annotations
import json
import shutil
import os
import sys
import subprocess
import stat
import tempfile
import threading
import zipfile
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

LANGUAGES = {'en':'English','zh':'中文','ja':'日本語','ko':'한국어','fr':'Français','de':'Deutsch','es':'Español'}
INDEX = 'https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json'
MAX_MODEL = 400 * 1024 * 1024


def validate_segments(data, maximum=32):
    if not isinstance(data, list) or not 1 <= len(data) <= maximum:
        raise ValueError(f'Provide 1–{maximum} transcript segments')
    ids=set()
    for item in data:
        if not isinstance(item,dict) or not isinstance(item.get('id'),str) or not 1 <= len(item['id']) <= 200 or item['id'] in ids:
            raise ValueError('Segment IDs must be unique strings')
        if not isinstance(item.get('text'),str) or not 1 <= len(item['text']) <= 4000:
            raise ValueError('Each segment must contain 1–4000 characters')
        ids.add(item['id'])
    if sum(len(x['text']) for x in data)>40000:
        raise ValueError('The translation batch is too large')
    return data


class LocalTranslator:
    def __init__(self, directory):
        self.directory=Path(directory)
        self.lock=threading.Lock()
        self.loaded=None

    def available(self):
        return [{'source':a,'target':b} for a in LANGUAGES for b in LANGUAGES
                if (self.directory/f'{a}-{b}'/'metadata.json').is_file()]

    def install(self, source, target):
        destination=self.directory/f'{source}-{target}'
        if (destination/'metadata.json').is_file(): return destination
        if (source,target)==('en','zh'):
            return self.install_opus(destination)
        with urlopen(INDEX,timeout=30) as response:
            index=json.loads(response.read(2*1024*1024))
        candidates=[p for p in index if p.get('from_code')==source and p.get('to_code')==target]
        if not candidates: raise ValueError('No direct local model for this language pair; choose another pair')
        package=candidates[-1]
        urls=[u for u in package.get('links',[]) if urlparse(u).scheme=='https' and urlparse(u).hostname in {'argos-net.com','www.argos-net.com','github.com','raw.githubusercontent.com','argosopentech.nyc3.digitaloceanspaces.com'}]
        if not urls: raise ValueError('No approved model download source')
        self.directory.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=self.directory) as td:
            root=Path(td);archive=root/'model.zip'
            with urlopen(urls[0],timeout=60) as response, archive.open('wb') as out:
                total=0
                while chunk:=response.read(1024*1024):
                    total+=len(chunk)
                    if total>MAX_MODEL: raise ValueError('Model exceeds 400 MiB download limit')
                    out.write(chunk)
            unpack=root/'unpack';unpack.mkdir()
            with zipfile.ZipFile(archive) as z:
                if sum(i.file_size for i in z.infolist())>800*1024*1024:
                    raise ValueError('Model archive is too large')
                for i in z.infolist():
                    p=Path(i.filename)
                    if p.is_absolute() or '..' in p.parts or stat.S_ISLNK(i.external_attr>>16):
                        raise ValueError('Unsafe model archive')
                z.extractall(unpack)
            metas=list(unpack.glob('*/metadata.json'))
            if len(metas)!=1: raise ValueError('Invalid translation model layout')
            model=metas[0].parent;meta=json.loads(metas[0].read_text())
            if (meta.get('from_code'),meta.get('to_code'))!=(source,target) or not (model/'sentencepiece.model').is_file() or not (model/'model'/'model.bin').is_file():
                raise ValueError('Unsupported translation model format')
            model.rename(destination)
        return destination

    def install_opus(self, destination):
        self.directory.mkdir(parents=True,exist_ok=True)
        environment=dict(os.environ)
        environment.update({'HF_HOME':str(self.directory/'.hf-cache'),'HF_XET_CACHE':str(self.directory/'.hf-cache'/'xet'),'HF_HUB_DISABLE_IMPLICIT_TOKEN':'1'})
        try:
            subprocess.run([sys.executable,str(Path(__file__).resolve()),'--prepare-opus',str(destination)],env=environment,capture_output=True,text=True,check=True,timeout=600)
        except subprocess.SubprocessError:
            raise ValueError('英中模型准备失败，请确认 ./install.sh --translation 已完成、网络可访问官方模型源且磁盘空间充足。不会切换付费服务。') from None
        if not (destination/'metadata.json').is_file():raise ValueError('Model preparation did not finish')
        return destination

    def _prepare_opus(self, destination):
        try:
            from transformers import MarianTokenizer
            from huggingface_hub import snapshot_download, configure_http_backend
            if os.environ.get('SSL_CERT_FILE'):
                import requests
                def trusted_session():
                    session=requests.Session();session.verify=os.environ['SSL_CERT_FILE'];return session
                configure_http_backend(backend_factory=trusted_session)
            import torch
            import ctranslate2
        except ImportError:
            raise ValueError('英中离线模型需要可选依赖，请在本机运行 ./install.sh --translation 后重试') from None
        self.directory.mkdir(parents=True,exist_ok=True)
        # A different first-party model, never a mirror/proxy for a blocked host.
        name='Helsinki-NLP/opus-mt-en-zh'
        from huggingface_hub import constants
        constants.HF_XET_CACHE=str(self.directory/'.xet-cache')
        with tempfile.TemporaryDirectory(dir=self.directory) as td:
            root=Path(td)
            source=snapshot_download(name,token=False,cache_dir=str(root/'download'),allow_patterns=['config.json','generation_config.json','source.spm','target.spm','tokenizer_config.json','vocab.json','pytorch_model.bin'])
            prepared=root/'prepared';prepared.mkdir()
            tokenizer=MarianTokenizer.from_pretrained(source,local_files_only=True)
            tokenizer.save_pretrained(prepared/'tokenizer')
            ctranslate2.converters.TransformersConverter(source,trust_remote_code=False).convert(str(prepared/'model'),quantization='int8')
            (prepared/'metadata.json').write_text(json.dumps({'engine':'opus','from_code':'en','to_code':'zh','package_version':'Helsinki-NLP/opus-mt-en-zh','target_prefix':'>>cmn_Hans<<'}))
            prepared.rename(destination)
        return destination

    def translate(self, source, target, segments, allow_download=False):
        if source not in LANGUAGES or target not in LANGUAGES or source==target:
            raise ValueError('Choose two different supported languages')
        validate_segments(segments)
        if not self.lock.acquire(blocking=False): raise ValueError('Another local translation is running; retry shortly')
        try:
            directory=self.directory/f'{source}-{target}'
            if not (directory/'metadata.json').is_file():
                if not allow_download: raise ValueError('Local model is missing; allow the first model download to continue')
                directory=self.install(source,target)
            import ctranslate2
            import sentencepiece
            if self.loaded is None or self.loaded[0]!=(source,target):
                meta=json.loads((directory/'metadata.json').read_text())
                if meta.get('engine')=='opus':
                    from transformers import MarianTokenizer
                    tokenizer=MarianTokenizer.from_pretrained(directory/'tokenizer',local_files_only=True)
                else:
                    tokenizer=sentencepiece.SentencePieceProcessor(model_file=str(directory/'sentencepiece.model'))
                model=ctranslate2.Translator(str(directory/'model'),device='cpu',compute_type='int8',inter_threads=1,intra_threads=4)
                self.loaded=((source,target),tokenizer,model,meta)
            _,tokenizer,model,meta=self.loaded
            opus=meta.get('engine')=='opus'
            tokens=[tokenizer.convert_ids_to_tokens(tokenizer(meta.get('target_prefix','')+' '+s['text']).input_ids) if opus else tokenizer.encode(s['text'],out_type=str) for s in segments]
            if any(len(t)>512 for t in tokens): raise ValueError('One cue is too long; split it before translation')
            prefix='' if opus else meta.get('target_prefix','')
            batches=model.translate_batch(tokens,target_prefix=[[prefix]]*len(tokens) if prefix else None,
                replace_unknowns=True,beam_size=4,length_penalty=.2,max_input_length=0,max_decoding_length=1024)
            output=[]
            for source_segment,result in zip(segments,batches,strict=True):
                hypothesis=result.hypotheses[0]
                if len(hypothesis)>=1024: raise ValueError('Translation output limit reached; no partial batch saved')
                text=(tokenizer.decode(tokenizer.convert_tokens_to_ids(hypothesis),skip_special_tokens=True) if opus else tokenizer.decode(hypothesis)).strip()
                if prefix and text.startswith(prefix): text=text[len(prefix):].strip()
                if not text: raise ValueError('Model returned an empty translation')
                output.append({'id':source_segment['id'],'text':text,'source_text':source_segment['text'],'provider':('local_opus_' if opus else 'local_argos_')+str(meta.get('package_version','unknown'))})
            return output
        finally: self.lock.release()


if __name__=='__main__':
    if len(sys.argv)!=3 or sys.argv[1]!='--prepare-opus':raise SystemExit('Internal model preparation command')
    destination=Path(sys.argv[2]).resolve()
    LocalTranslator(destination.parent)._prepare_opus(destination)
