/** Authored synthetic transcript, never sourced from third-party media. */
export function longReadingFixture(count = 1771) {
  const segments = Array.from({length: count}, (_, index) => {
    const sequence = index + 1;
    const length = [1, 2, 3, 1, 6, 2, 1, 4, 12][index % 9];
    const text = `Harbor notebook ${sequence}. ` +
      'We watched the morning light cross the harbor, then wrote down one detail worth keeping. '.repeat(length) +
      (index % 97 === 0 ? 'This measured passage is a compass-marker. ' : '') +
      (index === count - 1 ? 'The closing thought is a quiet-window. ' : '');
    const translation = `港口手记 ${sequence}。` +
      '我们看着晨光掠过港口，记下一个值得留下的细节。'.repeat(length + index % 3) +
      (index === count - 103 ? '这是只存在译文中的远方灯塔。' : '') +
      (index === count - 1 ? '末段保留一扇安静的窗。' : '');
    return {id: `harbor-${index}`, start: index * 4, end: index * 4 + 3.8,
      text, speaker: index % 13 === 0 ? 'Reader B' : 'Reader A',
      translations: {zh: {text: translation, source_text: text, source_language: 'en',
        document_language: 'en', provider: 'Original authored audit fixture'}}};
  });
  return {schema_version: 1, title: '港口手记 · 1,771 段自写长阅读验证', language: 'en',
    translation_view: 'zh', source_url: '',
    provenance: {kind: 'imported_subtitles', review_status: 'Original authored synthetic text; no source media or model calls'},
    segments, notes: {}};
}
