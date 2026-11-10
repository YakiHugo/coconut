"""Conservative source-anchored reading boundaries; audio pauses are evidence, not sentences.

Source cues, words, clocks and speaker ownership are never changed. Public marks
use UTF16 offsets. Research coordinates additionally retain Python codepoints.
"""
from __future__ import annotations
import argparse
from bisect import bisect_left
from copy import deepcopy
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import re
import sys
import time
import wave

POLICY_VERSION='conservative-boundaries-v1'
TERMINAL='。！？.!?'
COMMAS='，,；;'
PUNCT='，,。.!！？?；;：:、…'
CLOSERS='”’」』》）)]】'
OPEN_TO_CLOSE={'“':'”','‘':'’','「':'」','『':'』','"':'"'}
LEXEMES=('可能','恭喜','事情','创始人','顺利','合伙人','能力','这样子','的时候','因为','所以','但是','然后','非常','意思','理念','感觉','什么','为什么','怎么','自己','公司','市场','项目','投资','工作','需要','重要','信息','生活','成功','世界','产品','技术','人工智能','学习','最后','过去','现在','未来','没有','已经','应该','如果','比如','或者','虽然','也是','就是','不是','不会','一直','当时','当然','一样','能够')
FUNCTION_END=re.compile(r'(?:的|地|得|和|与|在|把|被|对|给|跟|为|从|向|很|更|比较|如果|因为|比如|虽然|或者|但是|所以|然后|就是|还有|一个|一种|那种|所谓|关于|怎么|可能|应该|不能|没有|不|才|又|想|要|将|会|能|到|像|是|说|讲|问|告诉|表示|认为|觉得|希望|以为|意识到|发现|忘了|记得|这个|那个|时候|的话|之前|之后|过程中|情况下|当然|总之|不过|其实)$')
NEW_CLAUSE=re.compile(r'^(?:(?:然后|后来|但是|但|然而|不过|所以|因此|而且|另外|另一方面|总之|现在|有的时候)(?:呢)?|(?:我|你|他|她|它|我们|你们|他们|她们|它们)(?:觉得|认为|当时|后来|现在|就|也|还|没有|已经|从|说))')

def utf16_offset(text,offset):return len(text[:offset].encode('utf-16-le'))//2

def _cp(text,offset):
 if not isinstance(offset,int) or offset<0:raise ValueError('Invalid UTF16 offset')
 data=text.encode('utf-16-le')
 if offset*2>len(data):raise ValueError('Offset outside source')
 return len(data[:offset*2].decode('utf-16-le'))

def source_fingerprint(document):
 value={'language':document.get('language'),'source_url':document.get('source_url'),'segments':document['segments']}
 return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def _digest(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()

def _speaker(cue):return cue.get('speaker_id') or cue.get('speaker') or None

def _lexical(text):return ''.join(c for c in text if c.isalnum())

def _terminal(text):return text.rstrip().rstrip(CLOSERS).rstrip()[-1:] in TERMINAL and bool(text.rstrip().rstrip(CLOSERS).rstrip())

def _quote_masks(cues):
 # Transcripts can contain an unmatched opening quote. Do not let it turn the
 # remainder of a two-hour recording into one quotation. A balanced quotation
 # may span nearby cues; an unbalanced one protects its own source cue only.
 masks={c['id']:set() for c in cues};parts=[];ranges=[];pos=0
 for cue in cues:
  t=cue['text'];ranges.append((pos,pos+len(t),cue));parts.append(t+'\n');pos+=len(t)+1
 text=''.join(parts);covered=set()
 for start,end,cue in ranges:
  for local,ch in enumerate(cue['text']):
   absolute=start+local
   if absolute in covered or ch not in OPEN_TO_CLOSE:continue
   close=OPEN_TO_CLOSE[ch];stop=text.find(close,absolute+1)
   next_open=text.find(ch,absolute+1) if ch!=close else -1
   balanced=stop>=0 and stop-absolute<=500 and (next_open<0 or next_open>stop)
   finish=stop+1 if balanced else end
   for x,y,target in ranges:
    lo=max(absolute,x);hi=min(finish,y)
    if lo<hi:masks[target['id']].update(range(lo-x,hi-x));covered.update(range(lo,hi))
 return masks

def _lexeme_crosses(left,right):
 a=_lexical(left)[-12:];b=_lexical(right)[:12]
 if not a or not b:return False
 if a[-1:].isascii() and b[:1].isascii() and a[-1:].isalnum() and b[:1].isalnum():return True
 for word in LEXEMES:
  for k in range(1,len(word)):
   if a.endswith(word[:k]) and b.startswith(word[k:]):return True
 return False

def _incomplete(left,right):
 a=left.rstrip().rstrip('，,；;：:…').rstrip();b=right.lstrip('，,；;：:…嗯呃 ')
 return bool(a and b and (_lexeme_crosses(a,b) or FUNCTION_END.search(a) or len(_lexical(a))<=3 and not _terminal(a) or re.match(r'^(?:的还是|呢[？?]|了[。.!！])',b)))

def _dependent_pair(left,right):
 return bool((re.search(r'虽然|尽管|即使|即便',left) and re.match(r'^(?:但是|可是|不过|然而|还是|也)',right))
  or (re.search(r'因为',left) and re.match(r'^(?:所以|因此)',right))
  or (re.search(r'如果|假如|一旦|只要',left) and re.match(r'^(?:那|那么|就)',right))
  or (re.search(r'不但|不仅',left) and re.match(r'^(?:而且|还|也)',right)))

def _unresolved_dependency(left):
 # Preserve incomplete conditional/concessive clauses and A-not-A questions.
 # Merely adding a pause does not supply their missing main clause.
 for pattern,closure in [(r'如果|假如|倘若|一旦|只要',r'那么|那就|就|便|则'),(r'即使|即便',r'也|仍|还是'),(r'虽然|尽管',r'但是|可是|不过|还是|仍')]:
  starts=list(re.finditer(pattern,left))
  if starts and not re.search(closure,left[starts[-1].end():]):return True
 if re.search(r'([\u3400-\u9fff]{1,3})(?:没|不)\1$',left):return True
 if re.search(r'百分之[零一二三四五六七八九十百千万亿两点]+百分之[零一二三四五六七八九十百千万亿两点]+$',left):return True
 if re.search(r'[A-Za-z]$',left):return True
 return False

def _bound_words(cue):
 # The production binder only accepts complete identical lexical content. Work on
 # a copy, including its punctuation offsets; rejected clocks never become pauses.
 from audio_pipeline import bind_word_spans
 value=deepcopy(cue)
 if not value.get('words') or not bind_word_spans(value):return []
 previous=cue['start']
 for w in value['words']:
  if not all(isinstance(w.get(k),(int,float)) and math.isfinite(w[k]) for k in ('start','end')) or w['start']<previous-.05 or w['end']<w['start'] or w['end']>cue['end']+.05:return []
  previous=w['start']
 return value['words']

def build_acoustic_evidence(document,audio_path,work_dir):
 """Local VAD + RMS validation, cached by source, raw audio, model and options.

 Uses existing PyAV standardization and installed faster-whisper Silero weights;
 never downloads. Caller can pass the already normalized 16k mono PCM16 WAV.
 """
 import numpy as np
 import faster_whisper
 from faster_whisper.vad import get_speech_timestamps,VadOptions
 from audio_pipeline import prepare_audio
 started=time.monotonic();directory=Path(work_dir).resolve();directory.mkdir(parents=True,exist_ok=True)
 audio_path=Path(audio_path).resolve();audio_hash=_digest(audio_path)
 normalize_dir=directory/('audio-'+audio_hash[:16]);normalize_dir.mkdir(exist_ok=True)
 wav=Path(prepare_audio(audio_path,normalize_dir))
 model=Path(faster_whisper.__file__).parent/'assets/silero_vad_v6.onnx'
 options={'threshold':.5,'min_speech_duration_ms':40,'min_silence_duration_ms':80,'speech_pad_ms':0}
 identity={'schema_version':1,'source_fingerprint':source_fingerprint(document),'audio_sha256':audio_hash,'normalized_sha256':_digest(wav),'vad_model_sha256':_digest(model),'vad_runtime':importlib.metadata.version('faster-whisper'),'vad_options':options,'evidence_version':'vad-energy-gaps-v1'}
 cache=directory/'acoustic-evidence.json'
 if cache.exists():
  saved=json.loads(cache.read_text())
  if saved.get('identity')==identity:return saved
 with wave.open(str(wav),'rb') as f:
  if (f.getframerate(),f.getnchannels(),f.getsampwidth())!=(16000,1,2):raise ValueError('Expected normalized 16k mono PCM16 WAV')
  frames=f.getnframes();pcm=np.frombuffer(f.readframes(frames),dtype='<i2').astype(np.float32)/32768
 speech=get_speech_timestamps(pcm,VadOptions(**options));spans=[(z['start']/16000,z['end']/16000) for z in speech];starts=[a for a,b in spans]
 # 10ms energy, leaving the audio timeline intact.
 n=len(pcm)//160;energy=10*np.log10(np.mean(pcm[:n*160].reshape(n,160)**2,axis=1)+1e-12)
 def measure(a,b):
  d=b-a
  if d<=0:return {'gap_seconds':round(d,6),'confirmed_pause':False,'reason':'overlap_or_no_gap'}
  if a<0 or b>len(pcm)/16000+.05:return {'gap_seconds':round(d,6),'confirmed_pause':False,'reason':'clock_outside_audio'}
  overlap=0.;j=max(0,bisect_left(starts,a)-1)
  while j<len(spans) and spans[j][0]<b:
   x,y=spans[j];overlap+=max(0,min(b,y)-max(a,x));j+=1
  lo=max(0,math.ceil(a*100));hi=min(n,math.floor(b*100));inside=energy[lo:hi]
  context=np.concatenate((energy[max(0,lo-80):lo],energy[hi:min(n,hi+80)]))
  threshold=max(-55.,float(np.percentile(context,65))-15.) if len(context) else -50.
  quiet=inside<threshold;run=longest=0
  for flag in quiet:run=run+1 if flag else 0;longest=max(longest,run)
  fraction=float(np.mean(quiet)) if len(quiet) else 0.;voice=min(1.,overlap/d)
  confirmed=d>=.12 and voice<=.25 and fraction>=.6 and longest*.01>=.10
  return {'gap_seconds':round(d,6),'vad_speech_fraction':round(voice,4),'energy_quiet_fraction':round(fraction,4),'max_energy_quiet_seconds':round(longest*.01,3),'energy_threshold_dbfs':round(threshold,2),'confirmed_pause':bool(confirmed),'reason':'vad_and_energy_quiet' if confirmed else 'gap_not_confirmed_quiet','audio_start':a,'audio_end':b}
 gaps=[];words={};unbound=[]
 for cue in document['segments']:
  ww=_bound_words(cue);words[cue['id']]=ww
  if not ww:unbound.append(cue['id'])
  for left,right in zip(ww,ww[1:]):
   p=left['text_end'];gaps.append({'cue_id':cue['id'],'offset_cp':p,'at':utf16_offset(cue['text'],p),'kind':'word',**measure(left['end'],right['start'])})
 edges=[]
 for l,r in zip(document['segments'],document['segments'][1:]):
  lw,rw=words[l['id']],words[r['id']]
  a=lw[-1]['end'] if lw else l['end'];b=rw[0]['start'] if rw else r['start']
  edges.append({'left_cue_id':l['id'],'right_cue_id':r['id'],'kind':'cue','word_clocks_bound':bool(lw and rw),**measure(a,b)})
 result={'version':1,'identity':identity,'normalized_audio':str(wav),'duration_seconds':frames/16000,'vad_speech_regions':len(spans),'speech_intervals':spans,'gaps':gaps,'cue_gaps':edges,'unbound_word_cue_ids':unbound,'seconds':time.monotonic()-started,'warning':'VAD and energy validate acoustic quiet only, never a semantic sentence boundary.'}
 cache.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');return result

def plan_boundaries(document,*,acoustic_evidence=None,punctuation_candidates=None,reading_cleanup=None):
 """Return additive reading marks, punctuation masks, paragraph hints and issues."""
 cues=document['segments'];by={c['id']:c for c in cues};fingerprint=source_fingerprint(document)
 acoustic_evidence=acoustic_evidence or {}
 if acoustic_evidence and acoustic_evidence.get('identity',{}).get('source_fingerprint')!=fingerprint:raise ValueError('Acoustic evidence source mismatch')
 ag={(z['cue_id'],z['offset_cp']):z for z in acoustic_evidence.get('gaps',[])}
 cg={(z['left_cue_id'],z['right_cue_id']):z for z in acoustic_evidence.get('cue_gaps',[])}
 cleanup=reading_cleanup or document.get('reading_cleanup') or {};hidden={c['id']:set() for c in cues}
 for e in cleanup.get('decisions',[]):
  if e.get('action')=='hide' and e.get('cue_id') in by:
   t=by[e['cue_id']]['text'];hidden[e['cue_id']].update(range(_cp(t,e['from']),_cp(t,e['to'])))
 quote=_quote_masks(cues);marks=[];masks=[];breaks=[];edges=[];issues=[];research=[];seen=set();sentence_lengths={};run_length=0
 def visible(cue,a=0,b=None):return ''.join(ch for i,ch in enumerate(cue['text']) if a<=i<(len(cue['text']) if b is None else b) and i not in hidden[cue['id']])
 def issue(cue,a,b,reason,priority=2,candidates=None,context=None):
  key=(cue['id'],a,b,reason)
  if key in seen:return
  seen.add(key);v={'cue_id':cue['id'],'from':utf16_offset(cue['text'],a),'to':utf16_offset(cue['text'],b),'kind':'boundary','reason':reason,'priority':priority,'context_ids':context or [cue['id']]}
  if candidates:v['candidate_marks']=candidates
  issues.append(v)
 def accept(cue,p,mark,reason,evidence,replace=False):
  if any(z['cue_id']==cue['id'] and z['at']==utf16_offset(cue['text'],p) for z in marks):return
  if p in quote[cue['id']] or p-1 in quote[cue['id']]:return
  if replace:
   if p>=len(cue['text']) or cue['text'][p] not in COMMAS:return
   masks.append({'cue_id':cue['id'],'from':utf16_offset(cue['text'],p),'to':utf16_offset(cue['text'],p+1),'action':'hide','reason':'reading_boundary_punctuation'})
  v={'cue_id':cue['id'],'at':utf16_offset(cue['text'],p),'mark':mark,'reason':reason,'method':'rule'};marks.append(v);research.append({**v,'offset_cp':p,'evidence':evidence})
 # Existing commas are the safest locations: they already claim a word boundary.
 # Promote a subset only when both sides form complete propositions AND audio
 # actually contains quiet. No duration threshold independently creates a period.
 for cue in cues:
  text=cue['text'];last_terminal=0;accepted_here=[]
  for p,ch in enumerate(text):
   if ch in TERMINAL:last_terminal=p+1;continue
   if ch not in COMMAS or p in hidden[cue['id']]:continue
   left=visible(cue,last_terminal,p).strip(PUNCT+' ');right=visible(cue,p+1).lstrip(PUNCT+' ')
   if len(_lexical(left))<28 or not right or FUNCTION_END.search(left):continue
   if p in quote[cue['id']] or p-1 in quote[cue['id']]:continue
   if not NEW_CLAUSE.match(right) or _dependent_pair(left,right) or _unresolved_dependency(left):continue
   ev=ag.get((cue['id'],p+1),{})
   if ev.get('confirmed_pause'):
    accept(cue,p,'？' if re.search(r'(?:对吧|是吧|对不对|是不是)$',left) else '。','complete_clause_new_proposition_with_verified_pause',ev,replace=True);last_terminal=p+1;accepted_here.append(p)
   elif len(_lexical(left))>=75:
    issue(cue,max(last_terminal,p-85),min(len(text),p+85),'long_clause_new_proposition_without_verified_pause',1,[{'cue_id':cue['id'],'at':utf16_offset(text,p),'mark':'。'}])
  # No-punctuation candidate: a strong new-clause phrase at an aligned word gap.
  for (cid,p),ev in ag.items():
   if cid!=cue['id'] or not ev.get('confirmed_pause') or p<=0 or p>=len(text):continue
   if text[p-1] in PUNCT or text[p] in PUNCT or p in hidden[cid] or p-1 in hidden[cid]:continue
   a=max((i+1 for i,ch in enumerate(text[:p]) if ch in TERMINAL),default=0)
   left=visible(cue,a,p).strip(PUNCT+' ');right=visible(cue,p).lstrip(PUNCT+' ')
   if len(_lexical(left))<28 or not NEW_CLAUSE.match(right) or FUNCTION_END.search(left) or _dependent_pair(left,right) or _unresolved_dependency(left) or _lexeme_crosses(left,right):continue
   if any(abs(p-z)<18 for z in accepted_here):continue
   accept(cue,p,'。','unpunctuated_complete_clause_new_proposition_with_verified_pause',ev);accepted_here.append(p)
  # Bound the fallback context; a long unresolved run is a local candidate, never
  # an instruction to rewrite the recording. Existing questions stay untouched.
  spans=list(re.finditer(r'[^。！？.!?]{110,}',visible(cue)))
  if spans and not accepted_here:
   start=0;end=min(len(text),180);issue(cue,start,end,'long_spoken_clause_without_safe_rule_boundary',2)
  sentence_lengths[cue['id']]=len(_lexical(visible(cue)))
 for l,r in zip(cues,cues[1:]):
  a,b=visible(l),visible(r);same=bool(_speaker(l) and _speaker(l)==_speaker(r));continuation=not _terminal(a) and _incomplete(a,b);ev=cg.get((l['id'],r['id']),{})
  if not same:
   kind='speaker_turn' if _speaker(l) and _speaker(r) else 'uncertain';reason='source_speaker_boundary_preserved'
   if continuation:
    issue(l,max(0,len(l['text'])-80),len(l['text']),'lexical_continuation_conflicts_with_source_speaker_boundary',0,context=[l['id'],r['id']]);reason='possible_continuation_with_conflicting_or_unknown_speaker'
   run_length=0
  elif continuation:kind='continue';reason='incomplete_lexeme_or_syntax_continues_regardless_of_pause';run_length+=sentence_lengths.get(l['id'],0)
  elif _terminal(a):
   run_length+=sentence_lengths.get(l['id'],0)
   if run_length>=180 and not quote[l['id']]:kind='paragraph';reason='existing_sentence_end_after_reading_paragraph';breaks.append({'cue_id':l['id'],'at':utf16_offset(l['text'],len(l['text'])),'reason':reason});run_length=0
   else:kind='continue';reason='same_source_speaker_existing_sentence_end'
  else:kind='continue';reason='same_source_speaker_no_semantic_boundary_evidence';run_length+=sentence_lengths.get(l['id'],0)
  edges.append({'left_cue_id':l['id'],'right_cue_id':r['id'],'kind':kind,'left_offset':len(l['text']),'left_offset_utf16':utf16_offset(l['text'],len(l['text'])),'right_offset':0,'right_offset_utf16':0,'reason':reason,'evidence':ev})
 # Existing model suggestions may identify local risks, but never override rules,
 # numbers, quotes, original questions, or source speakers on their own.
 for z in punctuation_candidates or []:
  cid=z.get('cue_id');cue=by.get(cid)
  if not cue:continue
  try:p=_cp(cue['text'],z['at'])
  except (KeyError,ValueError,UnicodeDecodeError):continue
  if z.get('mark') not in ['。','，'] or p in quote[cid]:continue
  if p<len(cue['text']) and cue['text'][p] in '？?！!':continue
  if not any(m['cue_id']==cid and m['at']==z['at'] for m in marks):issue(cue,max(0,p-80),min(len(cue['text']),p+80),'specialized_punctuation_candidate_requires_local_review',3,[{'cue_id':cid,'at':z['at'],'mark':z['mark']}])
 issues.sort(key=lambda z:(z['priority'],cues.index(by[z['cue_id']]),z['from']))
 return {'version':1,'policyVersion':POLICY_VERSION,'source_fingerprint':fingerprint,'marks':marks,'decisions':masks,'breaks':breaks,'cue_boundaries':edges,'issues':issues,'research_marks':research,'acoustic_summary':{k:acoustic_evidence.get(k) for k in ('identity','duration_seconds','vad_speech_regions','unbound_word_cue_ids','seconds')} if acoustic_evidence else None,'llm_calls':0}

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('input',type=Path,nargs='?');parser.add_argument('--audio',type=Path);parser.add_argument('--work',type=Path,default=Path('.coconut/boundaries'));parser.add_argument('-o','--output',type=Path);parser.add_argument('--stdio',action='store_true');args=parser.parse_args()
 if args.stdio:
  req=json.load(sys.stdin);doc=req['document'];audio=req.get('audioPath');work=req.get('workDirectory') or str(args.work);cleanup=req.get('reading_cleanup')
 else:
  if not args.input:parser.error('input or --stdio required')
  doc=json.loads(args.input.read_text());audio=args.audio;work=args.work;cleanup=doc.get('reading_cleanup')
 evidence=None
 if audio:
  print('Checking local VAD and energy evidence',file=sys.stderr,flush=True)
  try:evidence=build_acoustic_evidence(doc,audio,work)
  except (ImportError,OSError,ValueError,RuntimeError) as e:print('Audio evidence unavailable: '+type(e).__name__,file=sys.stderr)
 plan=plan_boundaries(doc,acoustic_evidence=evidence,reading_cleanup=cleanup)
 if args.output:args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
 else:print(json.dumps(plan,ensure_ascii=False))
if __name__=='__main__':main()
