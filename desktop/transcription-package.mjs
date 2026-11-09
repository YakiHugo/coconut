/** Explicit local worker source closure. Models, environments and user data stay outside the app. */
import {copyFile,readFile} from 'node:fs/promises';
import path from 'node:path';

export const TRANSCRIPTION_RESOURCES=Object.freeze([
 'transcription.py','existing_alignment.py','audio_pipeline.py','audio_speakers.py',
 'transcript.py','transcript_readability.py','moss_asr.py','transcribe.py','local_asr.py','subtitle_import.py',
]);

export async function stageTranscriptionResources(sourceDirectory,resourcesDirectory){
 for(const name of TRANSCRIPTION_RESOURCES)await copyFile(path.join(sourceDirectory,name),path.join(resourcesDirectory,name));
 await verifyTranscriptionResources(resourcesDirectory);
}

export async function verifyTranscriptionResources(resourcesDirectory){
 for(const name of TRANSCRIPTION_RESOURCES){
  const content=await readFile(path.join(resourcesDirectory,name));
  if(content.length===0)throw Error('Packaged transcription resource is empty: '+name);
 }
}
