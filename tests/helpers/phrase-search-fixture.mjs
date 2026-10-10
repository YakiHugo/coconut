import {splitCueFixture} from './split-cue-fixture.mjs';

// Self-authored source and saved translations only. No model output or media.
export const SOURCE_PHRASE = 'left out the time';
export const TRANSLATED_PHRASE = '但我们忽略了人们所需的时间';
export function phraseSearchFixture(count = 24) {
  return {...splitCueFixture(count), title: 'Authored cross-cue phrase search'};
}
export function phraseContributorIds(count = 24) {
  const ids = [];
  for (let i = 1; i + 1 < count; i += 6) ids.push('split-' + i, 'split-' + (i + 1));
  return ids;
}
