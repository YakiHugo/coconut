/** Self-authored reading/navigation fixture. This is not a podcast transcript,
 * recording, model answer, translation-quality sample, or media timing proof. */
export const SEARCH_RETURN_MARKER = 'return-proof';
export const SEARCH_RETURN_DESTINATION = 'destination-900';
export const SEARCH_RETURN_INNER_DESTINATION = 'destination-905';
export const SEARCH_RETURN_ORIGIN = 'cue-282';

export function searchReturnFixture(label = 'desktop', count = 1001) {
  const fragments = ['We opened the notebook,', 'then checked the footpath,',
    'and kept each observation', 'beside its original wording,',
    'so a short reading detour', 'could return to the same place.'];
  const segments = Array.from({length: count}, (_, index) => {
    // A one-cue preface adds a real speaker boundary, placing cue-282 at the
    // start of a mounted eight-passage page with ample natural content below.
    // Viewport checks must not depend on test-only padding or scroll overrides.
    const speaker = index === 0 ? 'Preface' : Math.floor(index / 6) % 2 ? 'Rowan' : 'Iris';
    // Long, explicitly authored material remains below the paragraph's 800
    // character cap, but puts cue-905 below its beginning on a large-type phone.
    // This exposes landing on a paragraph header instead of the exact late cue.
    const detail = index === 901 ? ' We measured the narrow path and copied each small observation into this local notebook;'.repeat(5) + ' We kept the earlier words together on this page;' : '';
    const text = fragments[index % 6] + detail + ' ' + SEARCH_RETURN_MARKER + ' ' + index +
      (index === 900 ? ' ' + SEARCH_RETURN_DESTINATION : index === 905 ? ' ' + SEARCH_RETURN_INNER_DESTINATION : '');
    return {id: 'cue-' + index, start: index * 2, end: index * 2 + 1.8, text, speaker,
      ...(speaker === 'Iris' ? {saved_excerpt: true} : {}),
      translations: {zh: {text: '自写对照文字，第 ' + index + ' 段。', source_text: text,
        source_language: 'en', document_language: 'en', provider: 'Authored fixture; no model'}}};
  });
  return {schema_version: 1, key: 'authored-search-return-' + label,
    title: '搜索后回到阅读 · 自写导航验收 · ' + label, language: 'en', translation_view: 'zh',
    readingPosition: 'cue-19', notes: {'cue-19': 'A pre-existing, self-authored note.'}, segments,
    provenance: {kind: 'imported_subtitles', review_status: 'Self-authored navigation fixture; no media or model quality claim'}};
}
