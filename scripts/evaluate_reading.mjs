#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import passages from '../reader/passages.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/evaluate_reading.mjs DOCUMENT.json [...]');
  process.exit(1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const {outputFiles} = await build({
  absWorkingDir: root,
  tsconfig: 'frontend/tsconfig.json',
  stdin: {resolveDir: root, contents: `
    export {readingChapters, readingParagraphs} from './frontend/reader-workspace/reading-document.ts';
    export {createProjection} from './reader/disfluency.js';
  `},
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const {readingChapters, readingParagraphs, createProjection} = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64')
);

const fillerOnly = /^(?=.*[嗯唔呃啊哼额])(?:[嗯唔呃啊哼额\s，、。！？,.!?])+$/u;

function measure(document) {
  const cues = document.segments;
  const cleanup = document.reading_cleanup;
  let projection;
  if (cleanup) {
    const {decisions, marks, breaks, policyVersion, sourceSignature} = cleanup;
    projection = createProjection(document, {decisions, marks, breaks, policyVersion, sourceSignature});
  }

  const publisher = document.transcription_context?.chapters ?? [];
  const chapters = readingChapters(cues, document.reading_chapters ?? [], publisher, []);
  const anchors = new Set(chapters.map(chapter => chapter.cue_id));
  const cueById = new Map(cues.map(cue => [cue.id, cue]));
  const publisherStarts = new Map();
  let index = 0;
  for (const chapter of publisher) {
    while (index < cues.length && cues[index].end <= chapter.start) index++;
    const cue = cues[index];
    if (cue && !publisherStarts.has(cue.id)) publisherStarts.set(cue.id, chapter.start);
  }

  const pages = passages.build(cues, {source:cues, layout:'reading'});
  const stats = {paragraphs:0, filler_only_paragraphs:0, assigned_paragraphs_30_to_60s:0, assigned_paragraphs_over_60s:0};
  for (const page of pages) {
    const cuts = [0, ...page.cues.flatMap((cue, i) => i > 0 && anchors.has(cue.id) ? [i] : []), page.cues.length];
    for (let i = 1; i < cuts.length; i++) {
      const group = page.cues.slice(cuts[i-1], cuts[i]);
      const assigned = Boolean(passages.speakerIdentity(group[0]));
      const paragraphs = readingParagraphs(group, {separator:passages.separator, displayText:text => text, projection});
      for (const paragraph of paragraphs) {
        const runs = paragraph.runs.filter(run => run.pieces.some(piece => piece.text.trim()));
        if (!runs.length) continue;
        const text = paragraph.runs.map((run, i) => (paragraph.separators.get(i) ?? '') + run.pieces.map(piece => piece.text).join('')).join('').trim();
        stats.paragraphs++;
        if (fillerOnly.test(text)) stats.filler_only_paragraphs++;
        if (assigned) {
          const seconds = Number((Math.max(...runs.map(run => run.speech.end)) - runs[0].speech.start).toFixed(3));
          if (seconds > 60) stats.assigned_paragraphs_over_60s++;
          else if (seconds >= 30) stats.assigned_paragraphs_30_to_60s++;
        }
      }
    }
  }

  return {...stats,
    cleanup_issues: cleanup?.issues?.length ?? null,
    lexical_speaker_conflicts: cleanup?.issues?.filter(issue => issue.reason === 'lexical_continuation_conflicts_with_source_speaker_boundary').length ?? null,
    chapters: chapters.map(chapter => {
      const cueStart = cueById.get(chapter.cue_id).start;
      const publisherStart = chapter.kind === 'publisher' ? publisherStarts.get(chapter.cue_id) : null;
      return {title:chapter.title, kind:chapter.kind, cue_start:cueStart, publisher_start:publisherStart,
        offset_seconds:publisherStart == null ? null : Number((cueStart-publisherStart).toFixed(3))};
    }),
  };
}

const results = [];
for (const file of files) {
  const document = JSON.parse(await readFile(file, 'utf8'));
  results.push({file, ...measure(document)});
}
console.log(JSON.stringify(results, null, 2));
