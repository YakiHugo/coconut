/** Shared offline model configuration; no model installation or inference at startup. */
import path from 'node:path';
import {homedir} from 'node:os';
export function transcriptionConfig(env=process.env){
  const asrPython=env.COCONUT_ASR_PYTHON||null,modelDirectory=env.COCONUT_MODEL_DIRECTORY||null;
  if(asrPython&&!path.isAbsolute(asrPython))throw Error('COCONUT_ASR_PYTHON must be an absolute executable path.');
  if(modelDirectory&&!path.isAbsolute(modelDirectory))throw Error('COCONUT_MODEL_DIRECTORY must be absolute.');
  if(env.COCONUT_ASR_EXECUTOR_URL)throw Error('Standalone transcription now runs directly; configure COCONUT_ASR_PYTHON instead of COCONUT_ASR_EXECUTOR_URL.');
  const backend=env.COCONUT_ASR_BACKEND||'qwen-mlx';
  if(!['qwen-mlx','moss-mlx','faster-whisper'].includes(backend))throw Error('Unsupported COCONUT_ASR_BACKEND');
  const root=modelDirectory||path.join(homedir(),'.coconut','models');
  // Each backend is a complete recipe. Inactive Qwen/acoustic settings must
  // neither make MOSS unavailable nor change the identity of its cached work.
  const moss=backend==='moss-mlx';
  const asrProfile={backend,model_cache:modelDirectory||undefined,asr_model:env.COCONUT_ASR_MODEL||path.join(root,moss?'MOSS-Transcribe-Diarize-MLX-8bit':'Qwen3-ASR-1.7B-8bit'),align_model:moss?'':env.COCONUT_ALIGN_MODEL||path.join(root,'Qwen3-ForcedAligner-0.6B-8bit'),
    segmentation:moss?'':env.COCONUT_SPEAKER_SEGMENTATION_MODEL||'',embedding:moss?'':env.COCONUT_SPEAKER_EMBEDDING_MODEL||''};
  for(const value of [asrProfile.asr_model,asrProfile.align_model,asrProfile.segmentation,asrProfile.embedding])if(value&&!path.isAbsolute(value))throw Error('Transcription models require absolute local paths.');
  return {asrPython,asrProfile,modelDirectory};
}
