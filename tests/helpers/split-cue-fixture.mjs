/** Self-authored caption fragments. Adjacent cues complete a thought; no AI. */
export function splitCueFixture(count = 1771) {
  const phrases = ['The station plan looked faster,', 'but we had left out',
    'the time people needed', 'to cross the road safely.',
    'Our first estimate changed', 'after we watched the crossing.'];
  const chinese = ['车站方案看起来更快，', '但我们忽略了', '人们所需的时间，',
    '才能安全穿过马路。', '我们最初的估计发生了变化，', '在观察路口之后。'];
  const segments = Array.from({length: count}, (_, i) => {
    const text = phrases[i % phrases.length] + (i === 1750 ? ' crossing-marker' : '');
    return {id: 'split-' + i, start: i * 1.8, end: i * 1.8 + 1.7,
      text, speaker: i % 12 < 6 ? 'Mina' : 'Leo',
      translations: {zh: {text: chinese[i % chinese.length], source_text: text,
        source_language: 'en', document_language: 'en', provider: 'Authored fixture'}}};
  });
  return {schema_version: 1, title: '路口观察 · 连续字幕阅读验证', language: 'en',
    translation_view: 'zh', segments, notes: {}, readingPosition: 'split-19',
    provenance: {kind: 'imported_subtitles', review_status: 'Self-authored fragments; no model output'}};
}
