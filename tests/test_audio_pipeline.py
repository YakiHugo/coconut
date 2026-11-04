"""Provider-independent clocks, recovery, and recording-wide acoustic identity."""
import copy
import json
import math
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from audio_pipeline import (CallableBackend, JsonCommandBackend, SAMPLE_RATE, owned_segments, stitch_segments,
                            plan_chunks, run_audio_pipeline, validate_result)
from audio_speakers import (SpeakerRegistry, label_segments, label_aligned_segments,
                            reconcile_recording_speakers, SherpaSpeakerBackend)
from transcript import make_document


def wav(path, seconds=20):
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
        for _ in range(seconds):
            stream.writeframesraw(b'\0' * SAMPLE_RATE * 2)


def evidence(vector, duration=3):
    return {'embedding': vector, 'duration': duration}


class RegistryTests(unittest.TestCase):
    def test_local_numbers_swap_and_voice_returns_after_absence_or_language_change(self):
        registry = SpeakerRegistry()
        first = registry.resolve({'0': evidence([1, 0, 0]), '1': evidence([0, 1, 0])}, 'voice-v1')
        self.assertEqual([first[x]['speaker_id'] for x in ('0', '1')], ['speaker-0001', 'speaker-0002'])
        registry.resolve({}, 'voice-v1')  # Arbitrarily long silence / absent guest.
        second = registry.resolve({'0': evidence([0, 1, .02]), '1': evidence([1, 0, .02])}, 'voice-v1')
        self.assertEqual([second[x]['speaker_id'] for x in ('0', '1')], ['speaker-0002', 'speaker-0001'])
        self.assertEqual(len(registry.voices), 2)

    def test_ambiguous_or_short_audio_never_merges_or_contaminates_prototypes(self):
        registry = SpeakerRegistry()
        registry.resolve({'a': evidence([1, 0]), 'b': evidence([0, 1])}, 'v1')
        before = copy.deepcopy(registry.voices)
        result = registry.resolve({'same-number': evidence([1, 1]), 'short': evidence([1, 0], .4)}, 'v1')
        self.assertEqual(result['same-number']['status'], 'ambiguous_match')
        self.assertIsNone(result['same-number']['speaker_id'])
        self.assertIsNone(result['short']['speaker_id'])
        self.assertEqual(registry.voices, before)

    def test_two_clusters_cannot_collapse_onto_one_old_voice(self):
        registry = SpeakerRegistry()
        registry.resolve({'old': evidence([1, 0])}, 'v1')
        result = registry.resolve({'a': evidence([1, .01]), 'b': evidence([1, -.01])}, 'v1')
        self.assertTrue(all(item['speaker_id'] is None for item in result.values()))
        self.assertEqual(len(registry.voices), 1)

    def test_reused_provider_label_is_not_identity_and_embedding_spaces_cannot_mix(self):
        registry = SpeakerRegistry()
        self.assertIsNone(registry.resolve({'0': {}}, None)['0']['speaker_id'])
        registry.resolve({'0': evidence([1, 0])}, 'v1')
        result = registry.resolve({'0': evidence([0, 1])}, 'v1')
        self.assertEqual(result['0']['speaker_id'], 'speaker-0002')
        with self.assertRaisesRegex(ValueError, 'model'):
            registry.resolve({'0': evidence([1, 0])}, 'v2')
        with self.assertRaisesRegex(ValueError, 'model'):
            registry.resolve({'0': evidence([1, 0, 0])}, 'v1')

    def test_duplicate_turns_do_not_create_false_majority_and_overlap_stays_unknown(self):
        segments = [{'start': 0, 'end': 10}]
        decisions = {'a': {'speaker_id': 'speaker-0001'}, 'b': {'speaker_id': 'speaker-0002'}}
        label_segments(segments, [{'start': 0, 'end': 4, 'speaker': 'a'}] * 3, decisions)
        self.assertIsNone(segments[0]['speaker_id'])
        label_segments(segments, [{'start': 0, 'end': 10, 'speaker': 'a'},
                                  {'start': 0, 'end': 10, 'speaker': 'b'}], decisions)
        self.assertEqual(segments[0]['speaker_status'], 'overlap_or_boundary')
        label_segments(segments, [{'start': 0, 'end': 10, 'speaker': 'a'},
                                  {'start': 0, 'end': 10, 'speaker': 'unknown'}], decisions)
        self.assertIsNone(segments[0]['speaker_id'], 'an unresolved competing voice must not disappear')


class RecordingSpeakerTests(unittest.TestCase):
    def block(self, evidence, turns, *, start=0, end=10, model='authored-v1'):
        return dict(start=start, core_start=start, core_end=end,
                    voices=dict(evidence=evidence, turns=turns, embedding_model=model))

    def test_split_local_clusters_merge_without_a_short_mixed_intro_becoming_a_person(self):
        blocks = [self.block({'intro': evidence([0, 0, 1], 2),
                             'a': evidence([1, 0, 0], 20),
                             'a-split': evidence([1, .03, 0], 15),
                             'b': evidence([0, 1, 0], 20)},
                    [dict(start=0, end=1, speaker='intro'), dict(start=1, end=3, speaker='a'),
                     dict(start=3, end=5, speaker='a-split'), dict(start=5, end=10, speaker='b')]),
                  self.block({'swapped': evidence([0, 1, .02], 20),
                              'other': evidence([1, 0, .02], 20)},
                    [dict(start=0, end=5, speaker='swapped'), dict(start=5, end=10, speaker='other')],
                    start=10, end=20)]
        before = copy.deepcopy(blocks)
        turns, count = reconcile_recording_speakers(blocks)
        self.assertEqual(count, 2)
        self.assertEqual([t['speaker_id'] for t in turns],
                         [None, 'speaker-0001', 'speaker-0001', 'speaker-0002', 'speaker-0002', 'speaker-0001'])
        self.assertEqual(blocks, before)
        self.assertEqual((turns[-1]['start'], turns[-1]['end']), (15, 20))

    def test_participant_count_does_not_force_unrelated_vectors_into_confident_labels(self):
        block = self.block({'a': evidence([1, 0, 0], 20), 'b': evidence([0, 1, 0], 20),
                            'c': evidence([0, 0, 1], 20)},
                           [dict(start=i, end=i+1, speaker=label) for i, label in enumerate('abc')])
        turns, count = reconcile_recording_speakers([block], expected_speakers=2)
        self.assertLessEqual(count, 2)
        self.assertTrue(any(t['speaker_id'] is None for t in turns))
        self.assertEqual(len(turns), 3, 'Unresolved speech is retained')
        for bad in (0, -1, True, 33):
            with self.assertRaises(ValueError):
                reconcile_recording_speakers([block], expected_speakers=bad)
        opposite = self.block({'a': evidence([1, 0], 20), 'b': evidence([-1, 0], 20)},
                              [dict(start=0, end=1, speaker='a'), dict(start=1, end=2, speaker='b')])
        turns, count = reconcile_recording_speakers([opposite], expected_speakers=1)
        self.assertEqual(count, 0)
        self.assertTrue(all(turn['speaker_id'] is None for turn in turns))

    def test_global_reconciliation_preserves_unknown_competing_speech_and_checks_models(self):
        block = self.block({'a': evidence([1, 0], 20)},
                           [dict(start=0, end=10, speaker='a'), dict(start=0, end=10, speaker='unknown')])
        turns, count = reconcile_recording_speakers([block])
        segments = [dict(start=0, end=10, text='Both voices remain')]
        decisions = {t['speaker']: dict(speaker_id=t['speaker_id'], status=t['speaker_status']) for t in turns}
        label_segments(segments, turns, decisions)
        self.assertIsNone(segments[0]['speaker_id'])
        self.assertEqual(segments[0]['speaker_status'], 'overlap_or_boundary')
        with self.assertRaisesRegex(ValueError, 'model'):
            reconcile_recording_speakers([block, self.block({'a': evidence([1, 0], 20)}, [], model='other-model')])


class AlignedSpeakerTests(unittest.TestCase):
    decisions = {'a': {'speaker_id': 'speaker-0001'}, 'b': {'speaker_id': 'speaker-0002'}}

    def test_pauses_do_not_dilute_word_evidence_or_move_original_clocks(self):
        cue = dict(id='one', start=0, end=10, text='你好世界', words=[
            dict(word='你好', start=0, end=1), dict(word='世界', start=9, end=10)])
        before = copy.deepcopy(cue)
        result = label_aligned_segments([cue], [dict(start=0, end=1, speaker='a'),
                                               dict(start=9, end=10, speaker='a')], self.decisions)
        self.assertEqual(result[0]['speaker_id'], 'speaker-0001')
        for field in ('id', 'text', 'start', 'end', 'words'):
            self.assertEqual(result[0][field], before[field])

    def test_zero_duration_tokens_use_local_audio_and_boundary_competitors_remain_unknown(self):
        cues = [dict(id=str(t), start=t, end=t, text='嗯', words=[dict(word='嗯', start=t, end=t)])
                for t in (1, 2)]
        before = copy.deepcopy(cues)
        turns = [dict(start=0, end=2, speaker='a'), dict(start=2, end=3, speaker='b')]
        result = label_aligned_segments(cues, turns, self.decisions)
        self.assertEqual(result[0]['speaker_id'], 'speaker-0001')
        self.assertIsNone(result[1]['speaker_id'])
        self.assertEqual([c['words'] for c in result], [c['words'] for c in before])

    def test_fresh_asr_splits_on_voice_changes_with_lossless_text_words_and_stable_first_id(self):
        cue = dict(id='one', start=0, end=4, text='你好，再见。', words=[
            dict(word='你好，', start=0, end=2, text_start=0, text_end=3),
            dict(word='再见。', start=2, end=4, text_start=3, text_end=6)])
        before = copy.deepcopy(cue)
        turns = [dict(start=0, end=2, speaker='a'), dict(start=2, end=4, speaker='b')]
        unsplit = label_aligned_segments([copy.deepcopy(cue)], turns, self.decisions)
        self.assertIsNone(unsplit[0]['speaker_id'])
        self.assertEqual(unsplit[0]['speaker_status'], 'speaker_change_within_cue')
        split = label_aligned_segments([cue], turns, self.decisions, split=True)
        self.assertEqual([c['id'] for c in split], ['one', 'one-voice-2'])
        self.assertEqual([c['speaker_id'] for c in split], ['speaker-0001', 'speaker-0002'])
        self.assertEqual(''.join(c['text'] for c in split), before['text'])
        self.assertEqual([(w['word'], w['start'], w['end']) for c in split for w in c['words']],
                         [(w['word'], w['start'], w['end']) for w in before['words']])
        self.assertEqual(split[1]['words'][0]['text_start'], 0)
        self.assertEqual((split[0]['start'], split[-1]['end']), (before['start'], before['end']))

    def test_word_stage_keeps_unknown_overlaps_and_partial_alignment_intact(self):
        cue = dict(id='one', start=0, end=4, text='不要猜测', words=[dict(word='不要猜测', start=0, end=4)])
        turns = [dict(start=0, end=4, speaker='a'), dict(start=0, end=4, speaker='unknown')]
        result = label_aligned_segments([cue], turns, self.decisions, split=True)
        self.assertEqual(len(result), 1)
        self.assertIsNone(result[0]['speaker_id'])
        self.assertEqual(result[0]['speaker_status'], 'overlap_or_boundary')
        cue['words'][0]['word'] = '不要'
        result = label_aligned_segments([cue], turns, self.decisions, split=True)
        self.assertEqual(result[0]['text'], '不要猜测')

    def test_boundary_slivers_and_zero_length_sentence_tokens_do_not_invent_voice_changes(self):
        cue = dict(id='one', start=0, end=4, text='好我们言归正传吧', words=[
            dict(word='好', start=0, end=.3), dict(word='我们言归正传', start=.3, end=3.9),
            dict(word='吧', start=4, end=4)])
        turns = [dict(start=0, end=.3, speaker='b'), dict(start=.3, end=3.9, speaker='a'),
                 dict(start=3.9, end=5, speaker='b')]
        result = label_aligned_segments([cue], turns, self.decisions, split=True)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['speaker_id'], 'speaker-0001')
        self.assertEqual(result[0]['text'], '好我们言归正传吧')

    def test_mixed_local_cluster_is_recovered_per_utterance_without_inventing_a_voice(self):
        import numpy as np
        from types import SimpleNamespace
        class Extractor:
            def create_stream(self):
                class Stream:
                    def accept_waveform(self, rate, values):
                        self.values = values
                    def input_finished(self):
                        pass
                return Stream()
            def is_ready(self, stream):
                return True
            def compute(self, stream):
                return [1, 0] if np.mean(stream.values) > 0 else [0, 1]
        backend = object.__new__(SherpaSpeakerBackend)
        backend.engine, backend.extractor = SimpleNamespace(sample_rate=SAMPLE_RATE), Extractor()
        turns, audio = [], []
        # Two independent reference utterances per identity, then a rejected
        # local cluster that actually merged utterances from both speakers.
        for i, (voice, sign) in enumerate([('speaker-0001', 1), ('speaker-0001', 1),
                                         ('speaker-0002', -1), ('speaker-0002', -1),
                                         (None, 1), (None, -1)]):
            audio.append(np.full(SAMPLE_RATE * 4, sign * 1000, dtype='<i2'))
            turns.append(dict(start=i*4, end=(i+1)*4, speaker=voice or 'unresolved:merged', speaker_id=voice))
        before = copy.deepcopy(turns)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'authored.wav'
            with wave.open(str(path), 'wb') as stream:
                stream.setparams((1, 2, SAMPLE_RATE, 0, 'NONE', 'not compressed'))
                stream.writeframes(np.concatenate(audio).tobytes())
            result = backend.refine_turns(path, turns)
        self.assertEqual([t['speaker_id'] for t in result[-2:]], ['speaker-0001', 'speaker-0002'])
        self.assertEqual(turns, before)


class PipelineTests(unittest.TestCase):
    def test_wrong_duration_is_rejected_before_asr_or_voice_inference(self):
        with tempfile.TemporaryDirectory() as td:
            source = Path(td) / 'source.wav'
            wav(source, 2)
            backend = CallableBackend({'backend': 'must-not-run'}, lambda _: self.fail('No ASR'))
            for options in ({'expected_duration': 50}, {'minimum_duration': 50}):
                with self.subTest(options=options), self.assertRaisesRegex(ValueError, 'duration|timing'):
                    run_audio_pipeline(source, backend, **options)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.audio = self.root / 'recording.wav'
        wav(self.audio)

    def tearDown(self):
        self.temp.cleanup()

    def test_three_hour_plan_has_exact_coverage_and_bounded_context(self):
        frames = 3 * 3600 * SAMPLE_RATE + 7
        chunks = plan_chunks(frames)
        self.assertEqual(len(chunks), 19)
        self.assertEqual(chunks[0].core_start_frame, 0)
        self.assertEqual(chunks[-1].core_end_frame, frames)
        self.assertTrue(all(a.core_end_frame == b.core_start_frame for a, b in zip(chunks, chunks[1:])))
        self.assertTrue(all(chunk.duration <= 610 for chunk in chunks))
        for size, context in [(0, 0), (10, 5), (math.nan, 0), (10, -1)]:
            with self.assertRaises(ValueError):
                plan_chunks(frames, size, context)

    def test_context_ownership_preserves_each_boundary_word_once_in_global_clock(self):
        chunks = plan_chunks(20 * SAMPLE_RATE, 10, 2)
        output = []
        for chunk in chunks:
            result = {'segments': [{'start': 8.8 - chunk.start, 'end': 10.8 - chunk.start,
                                   'text': '边界前 boundary after', 'speaker': 'speaker_0',
                                   'words': [{'start': 8.8 - chunk.start, 'end': 9.4 - chunk.start, 'word': '边界前'},
                                             {'start': 10.2 - chunk.start, 'end': 10.8 - chunk.start, 'word': ' boundary after'}]}]}
            output.extend(owned_segments(validate_result(result, chunk.duration), chunk, 20 * SAMPLE_RATE))
        self.assertEqual([s['text'] for s in output], ['边界前', 'boundary after'])
        self.assertEqual([(s['start'], s['end']) for s in output], [(8.8, 9.4), (10.2, 10.8)])
        self.assertTrue(all(s['speaker_id'] is None for s in output))
        self.assertEqual([s['provider_speaker'] for s in output], ['0:speaker_0', '1:speaker_0'])

    def test_unrelated_turn_shorter_than_three_percent_is_retained(self):
        # There is no duration-percentage filter on recording identities.
        registry = SpeakerRegistry()
        ids = registry.resolve({'host': evidence([1, 0], 3600), 'guest': evidence([0, 1], 2)}, 'v1')
        segment = {'start': 3600, 'end': 3602}
        label_segments([segment], [{'start': 3600, 'end': 3602, 'speaker': 'guest'}], ids)
        self.assertEqual(segment['speaker_id'], 'speaker-0002')

    def test_unknown_competing_voices_survive_turn_export_and_readability_replay(self):
        class Voices:
            cache_key = {'fixture': 'known-and-unresolved-overlap'}
            local_only = True

            def analyze(inner, path):
                return {'embedding_model': 'v1', 'evidence': {'known': evidence([1, 0])},
                        'turns': [{'start': 0, 'end': 10, 'speaker': 'known'},
                                  {'start': 0, 'end': 10, 'speaker': 'short'}]}

        backend = CallableBackend({'fixture': 'overlap'}, lambda _: {'segments': [
            {'start': 2, 'end': 4, 'text': 'Overlapping voices'}]})
        result = run_audio_pipeline(self.audio, backend, speaker_backend=Voices(),
                                    chunk_seconds=10, context_seconds=0, local_only=True)
        self.assertEqual([s['speaker_id'] for s in result['segments']], [None, None])
        self.assertEqual([s['speaker_status'] for s in result['segments']],
                         ['overlap_or_boundary'] * 2)

        turns = result['speaker_turns']
        known = [turn for turn in turns if turn['speaker_id']]
        unresolved = [turn for turn in turns if turn['speaker_id'] is None]
        self.assertEqual([turn['speaker_id'] for turn in known], ['speaker-0001'] * 2)
        self.assertEqual([turn['speaker'] for turn in unresolved],
                         ['unresolved:0:short', 'unresolved:1:short'])
        decisions = {turn['speaker']: {'speaker_id': turn['speaker_id'],
                                      'status': turn['speaker_status']} for turn in turns}
        source = {'segments': [{'id': str(index), 'start': start, 'end': start + 2,
                                'text': 'Overlapping voices', 'speaker': None}
                               for index, start in enumerate((2, 12))]}
        replayed = copy.deepcopy(source['segments'])
        label_segments(replayed, turns, decisions)
        self.assertEqual([s['speaker_id'] for s in replayed], [None, None])
        self.assertEqual([s['speaker_status'] for s in replayed], ['overlap_or_boundary'] * 2)

        # The standalone enhancement path consumes exported turns, without any
        # model runtime or downloads in this regression test.
        from transcript_readability import enhance_document
        before = copy.deepcopy(source)
        with patch.dict(sys.modules, {'sherpa_onnx': object()}), \
                patch('audio_pipeline.run_audio_pipeline', return_value=result), \
                patch('audio_speakers.SherpaSpeakerBackend', return_value=object()):
            enhanced = enhance_document(source, self.audio,
                                        segmentation=str(self.audio), embedding=str(self.audio))
        self.assertEqual(source, before)
        self.assertEqual([s['speaker_id'] for s in enhanced['segments']], [None, None])
        self.assertEqual([s['speaker_status'] for s in enhanced['segments']],
                         ['overlap_or_boundary'] * 2)

    def test_boundary_decoder_jitter_is_deduplicated_but_a_real_repetition_is_kept(self):
        def segment(chunk, start, end, text):
            return {'start': start, 'end': end, 'text': text, 'chunk_index': chunk,
                    'words': [{'start': start, 'end': end, 'word': text}]}
        output = stitch_segments([segment(0, 9.6, 10.2, 'Hello'), segment(1, 9.8, 10.4, ' hello'),
                                  segment(1, 10.4, 10.8, ' hello')])
        self.assertEqual(len(output), 2)
        self.assertEqual([item['start'] for item in output], [9.6, 10.4])

    def test_later_failure_reuses_completed_asr_and_acoustic_chunks_and_replays_ids(self):
        calls, voice_calls = [], []
        def recognize(path):
            index = int(path.stem.split('-')[-1])
            calls.append(index)
            return {'language': 'zh' if index == 0 else 'en', 'segments': [
                {'start': 2, 'end': 4, 'text': '原话' if index == 0 else 'Original words'}]}
        class Voices:
            cache_key = {'model': 'v1'}
            fail = True
            def analyze(inner, path):
                with wave.open(str(path), 'rb') as stream:
                    self.assertEqual(stream.getframerate(), SAMPLE_RATE)
                    duration = stream.getnframes() / SAMPLE_RATE
                self.assertLessEqual(duration, 12)
                index = len(voice_calls)
                voice_calls.append(index)
                if index == 1 and inner.fail:
                    inner.fail = False
                    raise RuntimeError('Interrupted acoustic inference')
                label = '0' if index == 0 else '9'
                return {'embedding_model': 'v1', 'evidence': {label: evidence([1, 0])},
                        'turns': [{'start': 0, 'end': duration, 'speaker': label}]}
        backend = CallableBackend({'provider': 'explicit-cloud-v1'}, recognize, local_only=False)
        voices = Voices()
        options = {'work_dir': self.root / 'checkpoints', 'speaker_backend': voices,
                   'chunk_seconds': 10, 'context_seconds': 2}
        with self.assertRaisesRegex(RuntimeError, 'Interrupted'):
            run_audio_pipeline(self.audio, backend, **options)
        self.assertEqual(calls, [0, 1])
        result = run_audio_pipeline(self.audio, backend, **options)
        self.assertEqual(calls, [0, 1], 'a retry must not charge for completed recognition chunks')
        self.assertEqual([s['speaker_id'] for s in result['segments']], ['speaker-0001'] * 2)
        self.assertEqual([s['start'] for s in result['segments']], [2, 10])
        self.assertIsNone(result['language'])
        self.assertEqual(result['languages'], ['zh', 'en'])
        before = copy.deepcopy(result)
        self.assertEqual(run_audio_pipeline(self.audio, backend, **options), before)
        self.assertEqual(len(voice_calls), 3)
        # Matching thresholds can be tuned without repeating either inference.
        run_audio_pipeline(self.audio, backend, speaker_threshold=.75, **options)
        self.assertEqual(calls, [0, 1])
        self.assertEqual(len(voice_calls), 3)
        self.assertFalse(list(options['work_dir'].glob('chunk-*.wav')))
        doc = make_document(result, 'Original', '')
        self.assertEqual(doc['segments'][1]['speaker_id'], 'speaker-0001')

    def test_cache_identity_includes_source_contents_provider_and_chunk_options(self):
        backend = CallableBackend({'model': 'v1'}, lambda _: {'segments': []})
        work = self.root / 'cache'
        run_audio_pipeline(self.audio, backend, work_dir=work)
        for change in ({'backend': CallableBackend({'model': 'v2'}, lambda _: {})}, {'chunk_seconds': 100}):
            with self.assertRaisesRegex(ValueError, 'different input/options'):
                run_audio_pipeline(self.audio, change.get('backend', backend), work_dir=work,
                                   **{k: v for k, v in change.items() if k != 'backend'})
        with self.audio.open('r+b') as stream:
            stream.seek(-1, 2)
            stream.write(b'\1')
        with self.assertRaisesRegex(ValueError, 'different input/options'):
            run_audio_pipeline(self.audio, backend, work_dir=work)

    def test_explicit_provider_command_and_local_backend_share_same_clock_and_recovery(self):
        script = self.root / 'provider.py'
        script.write_text('import json,sys,wave\nr=json.load(sys.stdin)\n'
                          'with wave.open(r["audio_path"]) as f: assert f.getframerate()==16000\n'
                          'assert r["timestamp_origin"]=="chunk" and len(r["request_id"])==64\n'
                          'print(json.dumps({"language":"en","segments":[{"start":2,"end":3,"text":"Actual subprocess bridge"}]}))\n')
        cloud = JsonCommandBackend([sys.executable, str(script)], identity='cloud-fixture-v1')
        local = CallableBackend({'local': 'v1'}, lambda _: {'language': 'en', 'segments': [
            {'start': 2, 'end': 3, 'text': 'Actual subprocess bridge'}]})
        result = run_audio_pipeline(self.audio, cloud, chunk_seconds=10, context_seconds=2)
        self.assertEqual(result, run_audio_pipeline(self.audio, local, chunk_seconds=10, context_seconds=2))
        with self.assertRaisesRegex(ValueError, 'Local-only'):
            run_audio_pipeline(self.audio, cloud, local_only=True)
        class CloudVoices:
            local_only = False
        with self.assertRaisesRegex(ValueError, 'Local-only'):
            run_audio_pipeline(self.audio, local, speaker_backend=CloudVoices(), local_only=True)

    def test_cli_provider_path_uses_same_pipeline_and_is_blocked_by_local_only(self):
        import contextlib
        import io
        from transcribe import main
        script = self.root / 'provider.py'
        script.write_text('import json,sys\nr=json.load(sys.stdin)\n'
                          'assert r["language_hint"]=="en"\n'
                          'print(json.dumps({"language":"en","segments":[{"start":2,"end":3,"text":"Cloud contract"}]}))\n')
        args = ['transcribe.py', str(self.audio), '--backend', 'json-command',
                '--provider-id', 'cloud-fixture-v1', '--language', 'en',
                '--provider-command', json.dumps([sys.executable, str(script)]),
                '--chunk-seconds', '10', '--chunk-context', '2',
                '--work-dir', str(self.root / 'cli'), '-o', str(self.root / 'result.md')]
        with patch.dict('os.environ', {}, clear=True), contextlib.redirect_stderr(io.StringIO()), \
                contextlib.redirect_stdout(io.StringIO()), patch('sys.argv', args):
            main()
            main()
        result = json.loads((self.root / 'result.json').read_text())
        self.assertEqual(result['provenance']['kind'], 'provider_asr')
        self.assertEqual(result['provenance']['audio_chunks'], '2')
        self.assertEqual([s['start'] for s in result['segments']], [2, 10])
        with patch('sys.argv', args + ['--local-files-only']), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                main()

    def test_same_task_cannot_call_provider_concurrently(self):
        from audio_pipeline import _directory
        backend = CallableBackend({'local': 'v1'}, lambda _: {'segments': []})
        work = self.root / 'cache'
        with _directory(work):
            with self.assertRaisesRegex(RuntimeError, 'Another worker'):
                run_audio_pipeline(self.audio, backend, work_dir=work)

    def test_provider_relative_timestamps_are_validated_before_checkpoint_commit(self):
        for segment in [{'start': 2, 'end': 500, 'text': 'Bad global clock'},
                        {'start': math.nan, 'end': 3, 'text': 'Bad'},
                        {'start': 0, 'end': 3, 'text': 'Bad', 'words': [{'start': 0, 'end': 4, 'word': 'bad'}]}]:
            with self.subTest(segment=segment), tempfile.TemporaryDirectory() as td:
                backend = CallableBackend({'test': 'invalid'}, lambda _: {'segments': [segment]})
                with self.assertRaises(ValueError):
                    run_audio_pipeline(self.audio, backend, work_dir=Path(td))
                self.assertFalse(list(Path(td).glob('asr-*.json')))


if __name__ == '__main__':
    unittest.main()
