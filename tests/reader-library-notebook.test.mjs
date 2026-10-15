// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';

const C=createRequire(import.meta.url)('../reader/core.js');

function fixture(){const docs=largeLibraryFixture(2,{cues:65});for(const doc of docs){doc.segments.forEach((cue,i)=>{cue.id='shared-'+i;cue.saved_excerpt=true;});doc.notes={'shared-64':'Private last note '+doc.key};}return docs;}

test('captures use document-qualified ownership, merge cue annotations once, and include blank bookmarks',()=>{
 const docs=fixture();docs.push({key:'audio',title:'Recording',segments:[],project_kind:'audio_only',project_note:'Audio thought',timestamp_bookmarks:[{id:'shared-64',time:90,note:''}]});
 const all=C.libraryCaptures(docs);assert.equal(all.length,132);assert.equal(new Set(all.map(c=>c.key)).size,132);
 assert.equal(all[64].excerpt,true);assert.equal(all[64].note,'Private last note shelf-0');assert.equal(C.libraryCaptures(docs,'','note').length,3);
 assert.equal(C.libraryCaptures(docs,'','excerpt').length,130);assert.equal(C.libraryCaptures(docs,'01:30').at(-1).type,'bookmark');
 assert.equal(C.libraryCaptures(docs,'Private last note shelf-1')[0].documentKey,'shelf-1');
});

test('selected-document export ignores query and duplicates, preserves corrected text and omits stale translation',()=>{
 const docs=fixture(),cue=docs[1].segments[64];cue.original_text='Before correction';docs[1].translation_view='zh';cue.translations={zh:{text:'STALE TEXT',source_text:'wrong'}};
 const output=C.libraryNotebookMarkdown(docs,['shelf-1','shelf-1','missing']);
 assert.match(output,/所选 1 篇/);assert.match(output,/shelf\\-1/);assert.match(output,/Before correction/);assert.match(output,/Private last note shelf/);assert.match(output,/译文已过期/);assert.doesNotMatch(output,/STALE TEXT|Authored document 0/);assert.match(output,/source sentence 0/);assert.match(output,/source sentence 64/);
});
