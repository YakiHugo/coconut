from copy import deepcopy
import json
import subprocess
import sys
import unittest
from transcript_boundaries import plan_boundaries,source_fingerprint,utf16_offset


def doc(*items):
 return {'language':'zh','segments':[{'id':f'cue-{i}','text':text,'start':i*2.,'end':i*2.+1.,'speaker_id':speaker} for i,(text,speaker) in enumerate(items)]}


def evidence(document,gaps=None,cue_gaps=None):
 return {'identity':{'source_fingerprint':source_fingerprint(document)},'gaps':gaps or [],'cue_gaps':cue_gaps or []}


def quiet(cid,p):
 return {'cue_id':cid,'offset_cp':p,'confirmed_pause':True,'gap_seconds':.36,'vad_speech_fraction':0.,'energy_quiet_fraction':1.,'max_energy_quiet_seconds':.3}


class TranscriptBoundaryTests(unittest.TestCase):
 def test_promotes_complete_clause_at_existing_comma_with_audio(self):
  text='我们过去很多年一直都在认真学习和观察这个行业的发展以及各种不同的选择，然后我觉得新的项目值得继续研究。'
  d=doc((text,'speaker-a'));p=text.index('，');before=deepcopy(d)
  result=plan_boundaries(d,acoustic_evidence=evidence(d,[quiet('cue-0',p+1)]))
  self.assertEqual(result['marks'],[{'cue_id':'cue-0','at':p,'mark':'。','reason':'complete_clause_new_proposition_with_verified_pause','method':'rule'}])
  self.assertEqual(result['decisions'][0]['from'],p)
  self.assertEqual(result['decisions'][0]['to'],p+1)
  self.assertEqual(d,before)

 def test_unverified_alignment_gap_does_not_create_sentence(self):
  text='我们过去很多年一直都在认真学习和观察这个行业的发展以及各种不同的选择，然后我觉得新的项目值得继续研究。'
  d=doc((text,'a'));p=text.index('，');gap=quiet('cue-0',p+1);gap.update(confirmed_pause=False,vad_speech_fraction=.9,gap_seconds=.96)
  self.assertFalse(plan_boundaries(d,acoustic_evidence=evidence(d,[gap]))['marks'])
  self.assertFalse(plan_boundaries(d)['marks'])

 def test_subject_and_predicate_continue_despite_long_pause(self):
  d=doc(('有一个说什么这次OpenAI','a'),('AI升级了，那肯定不会是我们说的。','a'))
  d['segments'][1]['start']=4.
  r=plan_boundaries(d,acoustic_evidence=evidence(d,cue_gaps=[{'left_cue_id':'cue-0','right_cue_id':'cue-1','confirmed_pause':True,'gap_seconds':3.}]))
  self.assertEqual(r['cue_boundaries'][0]['kind'],'continue')
  self.assertFalse(r['marks']);self.assertFalse(r['breaks'])

 def test_split_lexeme_with_speaker_conflict_routes_issue(self):
  d=doc(('为什么融资都不大顺','a'),('利？','b'));before=deepcopy(d)
  r=plan_boundaries(d)
  self.assertEqual(r['cue_boundaries'][0]['kind'],'speaker_turn')
  self.assertTrue(any(z['reason']=='lexical_continuation_conflicts_with_source_speaker_boundary' for z in r['issues']))
  self.assertFalse(r['marks']);self.assertEqual(d,before)

 def test_unknown_speakers_are_not_assumed_identical(self):
  r=plan_boundaries(doc(('幻想过很多可',None),('能。',None)))
  self.assertEqual(r['cue_boundaries'][0]['kind'],'uncertain')
  self.assertTrue(r['issues']);self.assertFalse(r['marks'])

 def test_question_quotes_numbers_and_english_are_protected(self):
  text='他说：“我们过去很多年一直都在认真学习和观察这个行业的发展以及不同的选择，然后我觉得四千二和四千五是两个数字。”你觉得呢？'
  d=doc((text,'a'));p=text.index('，');result=plan_boundaries(d,acoustic_evidence=evidence(d,[quiet('cue-0',p+1)]),punctuation_candidates=[{'cue_id':'cue-0','at':text.index('？'),'mark':'。'}])
  self.assertFalse(result['marks']);self.assertFalse(result['decisions'])
  d2=doc(('现在讨论的产品是ChatGPT for Google，还有版本1.5和四千二和四千五。','a'))
  self.assertFalse(plan_boundaries(d2)['marks'])

 def test_utf16_anchor_includes_non_bmp_character(self):
  text='😀我们过去很多年一直都在认真学习和观察这个行业的发展以及各种不同的选择，然后我觉得值得继续研究。'
  d=doc((text,'a'));p=text.index('，');r=plan_boundaries(d,acoustic_evidence=evidence(d,[quiet('cue-0',p+1)]))
  self.assertEqual(r['marks'][0]['at'],p+1)
  self.assertEqual(r['research_marks'][0]['offset_cp'],p)
  self.assertEqual(r['marks'][0]['at'],utf16_offset(text,p))

 def test_acoustic_cache_cannot_apply_to_different_source(self):
  first=doc(('第一段文字。','a'));second=doc(('第二段文字。','a'))
  with self.assertRaises(ValueError):plan_boundaries(second,acoustic_evidence=evidence(first))

 def test_reporting_verb_and_subordinate_construction_are_not_sentences(self):
  for text in [
   '我们一直都在这个行业里面工作也认识了非常多不同的人和他们聊过很多事情就说他当时最重要的选择。',
   '我们过去很多年一直都在认真学习和观察这个行业虽然我不知道应该怎么解释这个过程，但是我觉得还有很多需要学习的地方。',
   '我们一直都在认真回忆当时的感受和未来的很多可能如果这个人一直没有等到新的机会，然后他还需要继续努力。',
  ]:
   d=doc((text,'a'));p=text.index('，') if '，' in text else text.index('他当时')
   gap=quiet('cue-0',p+1 if text[p:p+1]=='，' else p)
   self.assertFalse(plan_boundaries(d,acoustic_evidence=evidence(d,[gap]))['marks'])

 def test_unmatched_quote_does_not_absorb_the_recording(self):
  first='他说：“这一句的引号没有闭合。'
  next_text='我们过去很多年一直都在认真学习和观察这个行业的发展以及各种不同的选择，然后我觉得值得继续研究。'
  d=doc((first,'a'),(next_text,'a'));p=next_text.index('，')
  r=plan_boundaries(d,acoustic_evidence=evidence(d,[quiet('cue-1',p+1)]))
  self.assertEqual(len(r['marks']),1);self.assertEqual(r['marks'][0]['cue_id'],'cue-1')

 def test_paragraph_hint_anchors_left_source_end(self):
  text='我们已经完成了这个完整命题。'*16
  d=doc((text,'a'),('然后我们继续讨论下一件事情。','a'));r=plan_boundaries(d)
  self.assertEqual(r['breaks'],[{'cue_id':'cue-0','at':utf16_offset(text,len(text)),'reason':'existing_sentence_end_after_reading_paragraph'}])

 def test_stdio_is_json_only_and_source_stable(self):
  d=doc(('幻想过很多可','a'),('能。','a'))
  result=subprocess.run([sys.executable,'transcript_boundaries.py','--stdio'],input=json.dumps({'document':d}),text=True,capture_output=True,check=True)
  payload=json.loads(result.stdout)
  self.assertEqual(payload['llm_calls'],0)
  self.assertEqual(payload['cue_boundaries'][0]['kind'],'continue')


if __name__=='__main__':unittest.main()
