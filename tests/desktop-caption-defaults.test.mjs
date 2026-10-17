import test from 'node:test';
import assert from 'node:assert/strict';
import {captionDefaultsFixture,feedUrl,trackUrl} from './fixtures/caption-defaults.mjs';
const request={protocolVersion:1,source:{kind:'url',url:feedUrl}};
async function discover(f){return (await f.service.ingest(request)).ingestion.selection.episodes[0];}
async function open(f,episode,track){return (await f.service.ingest({...request,episode:{feed_url:feedUrl,episode_id:episode.id,...(track?{transcript_url:trackUrl(track)}:{})}})).ingestion;}
test('actual RSS/coordinator ranks exact script before format, canonicalizes case, and preserves override',async()=>{
 const f=captionDefaultsFixture();f.state.tracks.pop();const episode=await discover(f);
 assert.equal(episode.transcript_selection.transcript_url,trackUrl('simplified.srt'));
 const result=await open(f,episode);assert.equal(result.transcript.document.language,'zh-hans');assert.match(result.transcript.document.segments[0].text,/simplified.srt/);
 assert.equal(f.calls.includes(trackUrl('traditional.vtt')),false);
 const override=await open(f,episode,'traditional.vtt');assert.equal(override.transcript.document.language,'zh-hant');
});
test('same canonical language VTT/SRT defaults by format and refresh revalidates rather than falling across scripts',async()=>{
 const f=captionDefaultsFixture(),episode=await discover(f);assert.equal(episode.transcript_selection.transcript_url,trackUrl('simplified.vtt'));
 assert.equal((await open(f,episode)).transcript.document.podcast_source.transcript_url,trackUrl('simplified.vtt'));
 f.state.tracks=f.state.tracks.slice(0,1);const fresh=await discover(f);assert.equal(fresh.transcript_selection.status,'choice_required');
 await assert.rejects(open(f,episode),/明确选择/);assert.equal(f.calls.includes(trackUrl('traditional.vtt')),false);
 await assert.rejects(open(f,episode,'simplified.vtt'),/不在此单集/);
});
for(const tag of ['not_a_language',''])test('missing/invalid track remains unknown and requires explicit choice: '+tag,async()=>{
 const f=captionDefaultsFixture();f.state.tracks=[['unknown.vtt','text/vtt',tag]];const episode=await discover(f);
 assert.equal(episode.transcripts[0].language,'');assert.equal(episode.transcripts[0].language_status,'invalid');assert.equal(episode.transcript_selection.status,'choice_required');
 await assert.rejects(open(f,episode),/明确选择/);const result=await open(f,episode,'unknown.vtt');assert.equal(result.transcript.document.language,null);assert.equal(result.transcript.document.provenance.language_basis,'unknown');
});
for(const tag of [null,'not_a_language','zh'])test('unknown/invalid/underspecified episode cannot imply an exact script: '+tag,async()=>{
 const f=captionDefaultsFixture();f.state.language=tag;const episode=await discover(f);assert.equal(episode.transcript_selection.status,'choice_required');await assert.rejects(open(f,episode),/明确选择/);
});
test('invalid episode xml:lang is not replaced with the valid feed language',async()=>{
 const f=captionDefaultsFixture();f.state.itemLanguage='not_a_language';const episode=await discover(f);assert.equal(episode.language,'');assert.equal(episode.language_status,'invalid');await assert.rejects(open(f,episode),/明确选择/);
});

test('missing track language inherits valid publisher episode language with an explicit basis',async()=>{
 const f=captionDefaultsFixture();f.state.tracks=[['unknown.vtt','text/vtt',null]];const episode=await discover(f);
 assert.equal(episode.transcripts[0].language_source,'inherited');assert.equal(episode.transcript_selection.status,'default');
 const result=await open(f,episode);assert.equal(result.transcript.document.language,'zh-hans');assert.equal(result.transcript.document.provenance.language_basis,'publisher_metadata_inherited');
 f.state.language=null;const unknown=await discover(f);assert.equal(unknown.transcripts[0].language_status,'missing');assert.equal(unknown.transcript_selection.status,'choice_required');
 const explicit=await open(f,unknown,'unknown.vtt');assert.equal(explicit.transcript.document.language,null);
});
test('same URL with conflicting publisher languages cannot import a different first tag',async()=>{
 const f=captionDefaultsFixture();f.state.language='en';f.state.tracks=[['same.vtt','text/vtt','fr'],['same.vtt','text/vtt','en']];const episode=await discover(f);
 assert.equal(episode.transcript_selection.status,'choice_required');assert.ok(episode.transcripts.every(track=>track.selection_conflict));await assert.rejects(open(f,episode),/明确选择/);await assert.rejects(open(f,episode,'same.vtt'),/冲突/);assert.equal(f.calls.includes(trackUrl('same.vtt')),false);
});
test('explicit empty xml:lang resets inherited language rather than restoring valid feed metadata',async()=>{
 const f=captionDefaultsFixture();f.state.itemLanguage='';f.state.language=null;f.state.tracks=[['unknown.vtt','text/vtt',null]];const episode=await discover(f);assert.equal(episode.language,'');assert.equal(episode.transcript_selection.status,'choice_required');assert.equal(episode.transcripts[0].language,'');await assert.rejects(open(f,episode),/明确选择/);
});
test('specific publisher language declarations outrank generic inherited XML language',async()=>{
 const {parsePodcastFeed}=await import('../desktop/podcast-sources.mjs');
 const rss=body=>`<rss xml:lang="fr" xmlns:p="https://podcastindex.org/namespace/1.0"><channel><language>en</language>${body}</channel></rss>`;
 const item=(attrs='',track='')=>`<item ${attrs}><guid>x</guid><p:transcript url="https://publisher.example.org/a.vtt" type="text/vtt" ${track}/></item>`;
 const inherited=parsePodcastFeed(rss(item()),feedUrl).episodes[0];assert.equal(inherited.language,'en');assert.equal(inherited.transcript_selection.status,'default');
 const specific=parsePodcastFeed(rss(item('xml:lang="en"')),feedUrl).episodes[0];assert.equal(specific.transcript_selection.status,'default');
 const trackConflict=parsePodcastFeed(rss(item('xml:lang="en"','language="en" xml:lang="fr"')),feedUrl).episodes[0];assert.equal(trackConflict.transcripts[0].language,'en');assert.equal(trackConflict.transcripts[0].selection_conflict,undefined);assert.equal(trackConflict.transcript_selection.status,'default');
});

test('missing RSS transcript language follows the dedicated channel language, not episode or transcript XML prose language',async()=>{
 const {parsePodcastFeed}=await import('../desktop/podcast-sources.mjs');
 const episode=parsePodcastFeed(`<rss xmlns:p="https://podcastindex.org/namespace/1.0"><channel><language>en</language><item xml:lang="fr"><guid>x</guid><p:transcript url="https://publisher.example.org/a.vtt" type="text/vtt" xml:lang="de"/></item></channel></rss>`,feedUrl).episodes[0];
 assert.equal(episode.language,'fr');assert.equal(episode.transcripts[0].language,'en');assert.equal(episode.transcripts[0].language_source,'inherited');assert.equal(episode.transcript_selection.status,'choice_required');
});
