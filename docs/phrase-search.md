# Source-backed phrase search

## Reading behavior

Search matches literal, locale-lowercased substrings of the readable source stream. Original cue text, timestamps, IDs, document objects, exports and notes are never rewritten to produce a match. English spaces, CJK joins, opening/closing punctuation and existing boundary whitespace use `CoconutPassages.separator`, also used by the actual passage renderer. Punctuation and whitespace are not discarded to manufacture a phrase.

Source continuity is shared with passage construction. Speaker changes, starts moving backwards, gaps greater than two seconds, missing array entries and explicit original-position gaps break a run. Visual paragraph target/hard limits and reader pagination do not break a run. Empty cues contribute no highlighted text or source ID; they are still visited for timing, adjacency and separator behavior.

Each saved translation language gets its own stream. Existing freshness checks decide whether that exact cue translation is current, including source/context, document language, glossary and human-review evidence. A missing or stale translation breaks that language’s stream. Search never combines different language fields, original and translation, or notes and speaker labels. Valid saved translations remain searchable in original-only view, preserving prior behavior. Their bounded previews identify the language and provide a keyboard-accessible action to show the corresponding bilingual text.

Overlapping matches produce merged exact UTF-16 highlight ranges. Case-fold expansions map back to the original code points. A cross-cue match retains all contributing cue IDs in source order and a bounded source-backed preview; every contributor can show that preview even when another contributor is on another result page or excluded by a metadata filter.

## Counts, navigation and AI

Results count unique contributing source cues, not phrase occurrences. Existing notes-only, excerpts-only and speaker filters intersect those cue IDs after matching against the complete source. Filtering never joins otherwise separated excerpts into a new phrase. Notes and speaker labels also retain independent single-field substring matching.

Next/previous result navigation, source-order pagination, real timestamps and the context/return detour remain cue-based. Search does not write a reading bookmark. An empty result after editing is truthful; it does not resurrect old text.

The same cue-membership predicate feeds visible results, AI count/plan controls and filtered source selection. Only contributing cues that pass the existing metadata filters become filtered sources. Search introduces no requests, auto-translation, model use or new consent. Existing request plans, approved context rules, immutable in-flight selections and consent-withdrawal behavior are unchanged. Matched translations/notes are not substituted for the original text in question requests.

Bookcase “title, original and notes” search also finds cross-cue original phrases with bounded previews and exact source destinations. It deliberately retains its existing original/notes scope; saved translations are searched inside the document. Project notes, bookmarks and individual notes remain separate fields.

## Index lifecycle and cost

`CoconutPassages.searchIndex` validates and indexes complete source-backed runs once, retaining verbatim joined text, folded text and cue-offset spans. `Coconut.searchDocument(doc, query)` caches that index by document identity and retains only the latest reading and original-only query result. Display-language, note, bookmark and excerpt changes do not rebuild source streams.

`Coconut.invalidateSearch(doc)` must be called after an in-place change to source text/timing/order/speaker, translations, translation contexts or glossary evidence, before any render or scoped AI membership check. Actual application hooks are:

- Original correction: immediately after `segment.text` changes in the edit handler
- Offline and subscription translation result application: after changing translations/context and before adopting any new displayed membership
- Glossary replacement: immediately after assigning the new terms
- `Coconut.saveManualTranslation`: immediately after applying the reviewed text

New/imported/restored/replaced document identities cannot inherit cached evidence. Replacing the source array, changing its length, changing document language, or replacing glossary/context containers also invalidates automatically. Arbitrary external in-place mutation without the explicit hook is not a supported cache contract. Persistence queue/receipt code stays independent; invalidation belongs at the mutation, not every save or render.

KMP scans each selected indexed stream and finds overlaps without query-length sliding windows. Overlapping intervals are merged before mapping highlights to source spans; monotonic span cursors avoid rescanning the full document for each occurrence. Preview text is bounded to 35 source code points before, 120 matching and 65 after, plus ellipses. Full contributing ID lists are materialized on demand; they are never truncated to fit a preview. Translation freshness may traverse its existing evidence dependencies during index construction.

## Verification

- `tests/reader-phrase-index.test.mjs`: source ranges, Unicode/case folding, punctuation, field/language boundaries, layout-only caps, explicit invalidation, metadata semantics, oversized previews, 50,000-cue source indexing and long overlapping queries
- `tests/reader-phrase-search.test.mjs`: actual HappyDOM handlers, labeled translations/reveal, source edits and stale evidence, context/page navigation, live annotations, import/restore/reload, and exact injected AI request membership
- `tests/phrase-search-browser.mjs`: authored desktop/mobile browser acceptance, run by GitHub Actions; browser execution is separate from Node/HappyDOM results

Performance diagnostics report timings and heap deltas for the actual authored test run. They are observations of that environment, not a promise for every device, transcript or translation dependency graph.

## Continue reading a found passage

“连贯阅读” follows the selected cue or the current search-context result rather
than jumping back to the explicit reading bookmark. The original query, filters,
translation view and result position remain a temporary return route while the
reader explores the passage or edits a neighboring cue's note. The same return
bar appears above continuous reading; “返回刚才的段落” returns within that detour,
whereas “返回结果” ends it and restores the search. Notes and source corrections
are retained. Returning never restores an older explicit bookmark.

Changing the query or filters, opening a summary or another document, or choosing
“留在全文” ends the temporary route. It is not a saved per-document reading session.
If a correction removes the original match, returning uses the existing adjacent
result or empty-results behavior. DOM regressions cover both nested returns and
retirement; the authored phrase-search browser journey checks keyboard navigation,
viewport restoration, the single return landmark and a durable note in CI.
