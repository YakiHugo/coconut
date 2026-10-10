import {splitCueFixture} from './split-cue-fixture.mjs';
/** Original authored fragment/translation fixture with deliberate provenance gaps. */
export function passageReadingFixture() {
  const fixture = splitCueFixture();
  fixture.title = '路口观察 · 先读完整意思，再回听一次';
  fixture.segments.forEach((cue, index) => {cue.start = index * .8; cue.end = (index + 1) * .8;});
  fixture.notes = {'split-2': '导入时已有的笔记：核对过街所需的时间。'};
  fixture.segments[4].saved_excerpt = true;
  fixture.segments[8].translations.zh.text = '这句旧译文不应混进连贯译文。';
  fixture.segments[8].translations.zh.source_text = 'A superseded source fragment';
  delete fixture.segments[10].translations;
  return fixture;
}
/** Dense early cues plus sparse late cues expose cue-index-based fake timelines. */
export function irregularPassageFixture() {
  const fixture = splitCueFixture(36);
  fixture.title = '不均匀时间轴 · 已有摘要仍能查原文';
  fixture.segments.forEach((cue, index) => {
    cue.start = index < 30 ? index * .8 : [120, 600, 1200, 1800, 2400, 3600][index - 30];
    cue.end = cue.start + .7;
  });
  fixture.ai_answers = [{purpose: 'summary', question: 'Authored summary fixture',
    answer: '这是作者预先写好的测试摘要。原文时间间隔不均匀，仍应能按实际时间查阅。',
    provider: 'Authored fixture; no model', citations: ['split-33'],
    input_snapshot: {version: 1, segments: fixture.segments.map(({id, text}) => ({id, text}))}}];
  return fixture;
}
