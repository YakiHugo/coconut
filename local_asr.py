"""Inspect the optional local ASR executor without loading or downloading a model.

The unified ingestion path deliberately supports one conservative model. Runtime
imports check dependency availability; model readiness is a read-only filesystem
check, not a claim that inference or model quality has been verified.
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import os
import re
from pathlib import Path

MODEL = 'small'
MODEL_REPOSITORY = 'Systran/faster-whisper-small'
DEPENDENCIES = {
    'faster_whisper': 'faster-whisper',
    'ctranslate2': 'ctranslate2',
    'av': 'av',
    'tokenizers': 'tokenizers',
    'huggingface_hub': 'huggingface-hub',
    'onnxruntime': 'onnxruntime',
    'numpy': 'numpy',
}
OFFLINE_ENVIRONMENT = {
    'HF_HUB_OFFLINE': '1',
    'TRANSFORMERS_OFFLINE': '1',
    'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1',
}


def _dependency_problems() -> tuple[list[str], list[str]]:
    missing, broken = [], []
    for module, package in DEPENDENCIES.items():
        try:
            if importlib.util.find_spec(module) is None:
                missing.append(package)
        except (ImportError, ValueError, AttributeError):
            missing.append(package)
    # Do not import a partially installed runtime. Imports below only check the
    # installed libraries; they never construct WhisperModel or a VAD session.
    if not missing:
        for module, package in DEPENDENCIES.items():
            try:
                importlib.import_module(module)
            except Exception:
                broken.append(package)
    return missing, broken


def _hub_cache() -> Path:
    home = os.environ.get('HF_HOME') or str(
        Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'huggingface')
    cache = (os.environ.get('HF_HUB_CACHE') or os.environ.get('HUGGINGFACE_HUB_CACHE')
             or str(Path(home) / 'hub'))
    return Path(cache).expanduser()


def _complete_model(directory: Path) -> bool:
    """Require the tokenizer too, so faster-whisper cannot fetch a fallback."""
    try:
        for name in ('model.bin', 'config.json', 'tokenizer.json'):
            path = directory / name
            if not path.is_file() or path.stat().st_size <= 0:
                return False
            with path.open('rb') as stream:
                if not stream.read(1):
                    return False
        if not any((directory / name).is_file() and (directory / name).stat().st_size > 0
                   for name in ('vocabulary.json', 'vocabulary.txt')):
            return False
        # Reject truncated/incomplete metadata before admitting an upload. Model
        # weights stay opaque: inspecting readiness must never instantiate them.
        for name in ('config.json', 'tokenizer.json'):
            path = directory / name
            if path.stat().st_size > 32 * 1024 * 1024:
                return False
            if not isinstance(json.loads(path.read_text(encoding='utf-8')), dict):
                return False
        return True
    except (OSError, ValueError, UnicodeError):
        return False


def cached_model_path(model_name: str = MODEL) -> Path | None:
    """Resolve an already present snapshot; never call a Hub/download API."""
    if model_name != MODEL:
        return None
    repository = _hub_cache() / ('models--' + MODEL_REPOSITORY.replace('/', '--'))
    try:
        snapshots = repository / 'snapshots'
        candidates = []
        reference = repository / 'refs' / 'main'
        if reference.is_file() and reference.stat().st_size <= 128:
            revision = reference.read_text().strip()
            if re.fullmatch(r'[a-fA-F0-9]{40}', revision):
                candidates.append(snapshots / revision)
        # Fully cached older revisions also remain usable without refreshing a
        # remote branch pointer. Ignore download temp files and malformed refs.
        if snapshots.is_dir():
            candidates.extend(sorted((path for path in snapshots.iterdir()
                                      if re.fullmatch(r'[a-fA-F0-9]{40}', path.name)), reverse=True))
        for candidate in dict.fromkeys(candidates):
            if _complete_model(candidate):
                return candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        pass
    return None


def executor_status(model_name: str = MODEL) -> dict:
    """Read-only readiness. No install, model initialization, or network calls."""
    status = {
        'available': False, 'code': 'missing_model', 'model': MODEL,
        'backend': 'faster-whisper', 'model_download': False, 'local_only': True,
        'upload_operations': 1,
        'inference_tested': False, 'missing_dependencies': [],
        'broken_dependencies': [], 'model_cached': False,
    }
    if model_name != MODEL:
        return {**status, 'code': 'invalid_model',
                'message': 'Local-only ingestion supports the small model only.'}
    missing, broken = _dependency_problems()
    status.update(missing_dependencies=missing, broken_dependencies=broken,
                  model_cached=cached_model_path(model_name) is not None)
    if missing or broken:
        packages = ', '.join(dict.fromkeys(missing + broken))
        status.update(code='missing_dependencies', message=(
            f'Local ASR dependencies are missing or cannot be imported: {packages}. '
            'Prepare the optional Python environment explicitly, then check again. '
            'Nothing has been installed or downloaded.'))
    elif not status['model_cached']:
        status['message'] = (
            'The complete small model is not in the local Hugging Face cache. '
            'Provide an existing Systran/faster-whisper-small snapshot with its '
            'weights, config, tokenizer and vocabulary, or explicitly prepare it '
            'outside this import. Nothing has been downloaded.')
    else:
        status.update(available=True, code='ready', message=(
            'Local dependencies and the cached small model are available. '
            'Inference has not been run or tested by this check.'))
    return status


def require_local_model(model_name: str = MODEL) -> Path:
    status = executor_status(model_name)
    if not status['available']:
        raise ValueError(status['message'])
    # Recheck and pin the existing path immediately before the model constructor.
    # If the cache disappeared, fail closed rather than passing a remote alias.
    directory = cached_model_path(model_name)
    if directory is None:
        raise ValueError('The cached small model is no longer available. No model was downloaded.')
    return directory
