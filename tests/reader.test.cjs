const test = require('node:test');
const assert = require('node:assert/strict');
const {parse, validate, source} = require('../reader/core.js');

test('exported JSON restores segment notes and excludes unknown segments', () => {
  const document = validate({title: 'Example', segments: [{id: 'a', start: 0, end: 2, text: 'Hello'}], notes: {a: 'Keep this thought', unknown: 'Ignore'}});
  const restored = parse(JSON.stringify(document), 'backup.json');
  assert.equal(restored.notes.a, 'Keep this thought');
  assert.equal(restored.notes.unknown, undefined);
});
test('untrusted note properties cannot change the object prototype', () => {
  const document = parse('{"segments":[{"id":"__proto__","start":0,"end":1,"text":"test"}],"notes":{"__proto__":"A valid note"}}', 'backup.json');
  assert.equal(Object.getPrototypeOf(document.notes), null);
  assert.equal(document.notes.__proto__, 'A valid note');
});
test('SRT timestamps preserve decimal seconds', () => {
  const document = parse('1\n00:00:01,250 --> 00:00:02,500\nHello', 'example.srt');
  assert.equal(document.segments[0].start, 1.25);
  assert.equal(document.segments[0].end, 2.5);
});
test('source links reject unsafe schemes and lookalike hosts', () => {
  assert.equal(source('javascript:alert(1)', 0), '');
  assert.equal(source('https://youtube.com.evil.example/a', 0), '');
  assert.equal(source('https://www.bilibili.com/video/example?p=2', 30), 'https://www.bilibili.com/video/example?p=2&t=30');
});
test('invalid segment chronology is rejected', () => {
  assert.throws(() => validate({segments: [{start: 2, end: 1, text: 'Invalid'}]}));
});
