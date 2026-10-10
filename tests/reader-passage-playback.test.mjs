import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {create} = require('../reader/passage-playback.js');

class Player extends EventTarget {
  constructor() {
    super(); this._time = 40; this.duration = 120; this.paused = true; this.ended = false;
    this.playbackRate = 1; this.src = 'blob:original'; this.error = null; this.plays = 0; this.pauses = 0;
    this.seekEvents = true;
  }
  get currentTime() { return this._time; }
  set currentTime(time) {
    if (this.seekError) throw Error('seek failed');
    this._time = time;
    if (this.seekEvents) { this.emit('seeking'); this.emit('seeked'); }
  }
  getAttribute(name) { return name === 'src' ? this.src : null; }
  emit(name) { this.dispatchEvent(new Event(name)); }
  pause() { this.pauses++; if (!this.paused) { this.paused = true; this.emit('pause'); } }
  async play() {
    this.plays++;
    if (this.playError) throw this.playError;
    if (this.pendingPlay) await this.pendingPlay;
    this.paused = false; this.ended = false; this.emit('play');
  }
  advance(time, event = 'timeupdate') { this._time = time; this.emit(event); }
}
function setup() {
  let player = new Player(), key = 'document-a', next = 0;
  const timers = new Map(), states = [];
  const controller = create({getPlayer: () => player, getDocumentKey: () => key,
    onChange: state => states.push(state),
    setTimer: (callback, delay) => { const id = ++next; timers.set(id, {callback, delay}); return id; },
    clearTimer: id => timers.delete(id)});
  return {controller, states, timers, get player() { return player; }, set player(value) { player = value; },
    set key(value) { key = value; }, tick() { const first = timers.entries().next().value; assert.ok(first); timers.delete(first[0]); first[1].callback(); }};
}
const range = {id: 'first–third', start: 10, end: 14, label: 'One connected passage'};

test('listen once seeks, preserves origin, pauses exactly at end without replacing existing handlers', async () => {
  const {controller, player, timers} = setup();
  const handler = () => {}; player.ontimeupdate = handler; player.onended = handler;
  assert.equal(await controller.listen(range), true);
  assert.equal(player.currentTime, 10); assert.equal(player.paused, false);
  assert.deepEqual(controller.getState().returnPosition, {time: 40, wasPlaying: false});
  player.advance(14.22);
  assert.equal(player.currentTime, 14); assert.equal(player.paused, true);
  assert.equal(controller.getState().status, 'finished'); assert.equal(timers.size, 0);
  assert.equal(player.ontimeupdate, handler); assert.equal(player.onended, handler);
  assert.equal(player.plays, 1);
});

test('end clock handles sparse timeupdate and rate changes without early cuts', async () => {
  const env = setup(); await env.controller.listen(range);
  env.player.playbackRate = 2; env.player._time = 13.8; env.player.emit('ratechange');
  assert.ok([...env.timers.values()][0].delay < 101);
  env.tick(); assert.equal(env.player.paused, false, 'elapsed timer is not evidence the media has reached its end');
  env.player._time = 14.03; env.tick();
  assert.equal(env.player.currentTime, 14); assert.equal(env.controller.getState().status, 'finished');
});

test('pause and resume keep the range, with no timer running while paused', async () => {
  const env = setup(); await env.controller.listen(range); env.player.pause();
  assert.equal(env.controller.getState().status, 'paused'); assert.equal(env.timers.size, 0);
  await env.player.play(); assert.equal(env.controller.getState().status, 'playing');
  env.player.advance(14); assert.equal(env.controller.getState().status, 'finished');
});

test('replay and another passage retain the original return position', async () => {
  const env = setup(); env.player.paused = false;
  await env.controller.listen(range); env.player.advance(14);
  await env.controller.replay(); assert.equal(env.player.currentTime, 10);
  await env.controller.listen({...range, id: 'next', start: 20, end: 24});
  assert.deepEqual(env.controller.getState().returnPosition, {time: 40, wasPlaying: true});
  assert.equal(await env.controller.returnToPrevious(), true);
  assert.equal(env.player.currentTime, 40); assert.equal(env.player.paused, false);
  assert.equal(env.controller.getState().status, 'idle');
});

test('return to a previously paused position does not start playback', async () => {
  const env = setup(); await env.controller.listen(range);
  await env.controller.returnToPrevious();
  assert.equal(env.player.currentTime, 40); assert.equal(env.player.paused, true); assert.equal(env.player.plays, 1);
  assert.equal(env.timers.size, 0); assert.equal(env.controller.getState().returnPosition, null);
});

test('continue releases the boundary and normal Play after completion does the same', async () => {
  for (const usingHelper of [true, false]) {
    const env = setup(); await env.controller.listen(range); env.player.advance(14);
    if (usingHelper) await env.controller.continue(); else await env.player.play();
    env.player.advance(18);
    assert.equal(env.player.paused, false); assert.equal(env.player.currentTime, 18);
    assert.equal(env.controller.getState().status, 'idle'); assert.equal(env.timers.size, 0);
  }
});

test('manual seeking inside or outside the range clears the return state', async () => {
  for (const time of [11, 38]) {
    const env = setup(); await env.controller.listen(range); env.player.currentTime = time;
    assert.equal(env.controller.getState().status, 'idle'); assert.equal(env.timers.size, 0);
    assert.equal(await env.controller.returnToPrevious(), false); assert.equal(env.player.currentTime, time);
  }
});

test('asynchronous internal seek events are accepted but later manual seeks cancel', async () => {
  const env = setup(); env.player.seekEvents = false; await env.controller.listen(range);
  env.player.emit('seeking'); env.player.emit('seeked');
  assert.equal(env.controller.getState().status, 'playing');
  env.player._time = 12; env.player.emit('seeking');
  assert.equal(env.controller.getState().status, 'idle');
});

test('cancel hands the player to existing cue-loop or ordinary controls without pausing', async () => {
  const env = setup(); await env.controller.listen(range); const pauses = env.player.pauses;
  env.controller.cancel(); env.player.currentTime = 3; env.player.advance(15);
  assert.equal(env.player.pauses, pauses); assert.equal(env.player.paused, false);
  assert.equal(env.player.currentTime, 15); assert.equal(env.timers.size, 0);
});

test('document, player, or source replacement clears paused or completed preview state', async () => {
  for (const change of [env => { env.key = 'document-b'; }, env => { env.player = new Player(); }, env => { env.player.src = 'blob:new'; }]) {
    const env = setup(); await env.controller.listen(range); env.player.advance(14); const old = env.player;
    change(env); assert.equal(env.controller.sync().status, 'idle');
    old.advance(15); assert.equal(env.controller.getState().returnPosition, null);
    assert.equal(await env.controller.replay(), false); assert.equal(env.timers.size, 0);
  }
});

test('replacement while playing is detected by the end clock', async () => {
  const env = setup(); await env.controller.listen(range); env.key = 'document-b'; env.tick();
  assert.equal(env.controller.getState().status, 'idle'); assert.equal(env.timers.size, 0);
});

test('invalid or unready media never seeks or interrupts an existing valid preview', async () => {
  const env = setup(); env.player.duration = NaN;
  assert.equal(await env.controller.listen(range), false); assert.equal(env.player.currentTime, 40); assert.equal(env.player.plays, 0);
  env.player.duration = 120; await env.controller.listen(range);
  for (const invalid of [{start: -1, end: 3}, {start: 10, end: 10}, {start: 2, end: 130}, {start: 0, end: Infinity}, null]) {
    assert.equal(await env.controller.listen(invalid), false); assert.equal(env.player.currentTime, 10);
    assert.equal(env.controller.getState().status, 'playing');
  }
});

test('autoplay failure keeps an explicit retry and return, and never retries on its own', async () => {
  const env = setup(); env.player.playError = Object.assign(Error('blocked'), {name: 'NotAllowedError'});
  assert.equal(await env.controller.listen(range), false);
  assert.equal(env.controller.getState().status, 'error'); assert.match(env.controller.getState().error, /再听一次/);
  assert.equal(env.player.paused, true); assert.equal(env.player.plays, 1); assert.equal(env.timers.size, 0);
  env.player.playError = null; assert.equal(await env.controller.replay(), true); assert.equal(env.player.plays, 2);
  assert.deepEqual(env.controller.getState().returnPosition, {time: 40, wasPlaying: false});
});

test('seek failure and media error are reported with no active end timer', async () => {
  const env = setup(); env.player.seekError = true;
  assert.equal(await env.controller.listen(range), false); assert.equal(env.controller.getState().status, 'error');
  env.player.seekError = false; await env.controller.replay(); env.player.error = {code: 3}; env.player.emit('error');
  assert.equal(env.controller.getState().status, 'error'); assert.equal(env.player.paused, true); assert.equal(env.timers.size, 0);
});

test('short ranges near media end finish once and natural ended never loops', async () => {
  const env = setup(); await env.controller.listen({...range, start: 119.95, end: 120});
  env.player._time = 120; env.player.ended = true; env.player.paused = true; env.player.emit('ended');
  assert.equal(env.controller.getState().status, 'finished'); assert.equal(env.player.currentTime, 120); assert.equal(env.player.plays, 1);
  env.player.emit('ended'); assert.equal(env.player.plays, 1); assert.equal(env.timers.size, 0);
});

test('a duration shrink or premature end fails safely instead of replaying', async () => {
  for (const event of ['durationchange', 'ended']) {
    const env = setup(); await env.controller.listen(range);
    if (event === 'durationchange') env.player.duration = 12;
    env.player.advance(12, event);
    assert.equal(env.controller.getState().status, 'error'); assert.equal(env.player.paused, true); assert.equal(env.player.plays, 1);
  }
});

test('late play rejection cannot damage a newer range or replacement document', async () => {
  for (const replace of [false, true]) {
    const env = setup(); let reject;
    env.player.pendingPlay = new Promise((resolve, fail) => { reject = fail; });
    const first = env.controller.listen(range); const old = env.player;
    if (replace) { env.player = new Player(); env.key = 'document-b'; }
    else old.pendingPlay = null;
    await env.controller.listen({...range, id: 'new', start: 30, end: 33});
    reject(Error('old request failed')); assert.equal(await first, false);
    assert.equal(env.controller.getState().range.id, 'new'); assert.equal(env.controller.getState().status, 'playing');
    assert.equal(env.controller.getState().error, ''); assert.equal(env.player.currentTime, 30);
  }
});

test('a very short passage remains finished if its play promise settles after the end event', async () => {
  const env = setup(); let resolve;
  env.player.play = () => {
    env.player.paused = false; env.player.emit('play');
    return new Promise(done => { resolve = done; });
  };
  const pending = env.controller.listen({...range, start: 13.99});
  env.player.advance(14); assert.equal(env.controller.getState().status, 'finished');
  resolve(); assert.equal(await pending, true);
  assert.equal(env.controller.getState().status, 'finished'); assert.equal(env.player.paused, true);
});

test('auto-stop or user pause may abort a pending play without turning completion or pause into an error', async () => {
  for (const finishing of [true, false]) {
    const env = setup(); let reject;
    env.player.play = () => {
      env.player.paused = false; env.player.emit('play');
      return new Promise((resolve, fail) => { reject = fail; });
    };
    const pending = env.controller.listen(range);
    if (finishing) env.player.advance(14); else env.player.pause();
    reject(Object.assign(Error('pause interrupted play'), {name: 'AbortError'}));
    assert.equal(await pending, finishing);
    assert.equal(env.controller.getState().status, finishing ? 'finished' : 'paused');
    assert.equal(env.controller.getState().error, ''); assert.equal(env.timers.size, 0);
  }
});

test('late successful play on a detached element is silenced without touching the new player', async () => {
  const env = setup(); let resolve;
  const old = env.player; old.pendingPlay = new Promise(done => { resolve = done; });
  const pending = env.controller.listen(range);
  env.player = new Player(); env.key = 'document-b';
  await env.controller.listen({...range, id: 'new', start: 30, end: 33});
  const pauses = env.player.pauses;
  resolve(); assert.equal(await pending, false);
  assert.equal(old.paused, true); assert.equal(env.player.paused, false); assert.equal(env.player.pauses, pauses);
  assert.equal(env.controller.getState().range.id, 'new'); assert.equal(env.player.currentTime, 30);
});

test('a stale successful continue cannot claim success or leave detached audio playing', async () => {
  const env = setup(); await env.controller.listen(range); env.player.advance(14);
  let resolve; const old = env.player; old.pendingPlay = new Promise(done => { resolve = done; });
  const pending = env.controller.continue();
  env.player = new Player(); env.key = 'document-b';
  resolve(); assert.equal(await pending, false); assert.equal(old.paused, true);
  assert.equal(env.player.plays, 0); assert.equal(env.controller.getState().status, 'idle');
});

test('disposal and emptied remove all ownership without starting or pausing ordinary playback', async () => {
  for (const remove of [env => env.controller.dispose(), env => env.player.emit('emptied')]) {
    const env = setup(); await env.controller.listen(range); const pauses = env.player.pauses;
    remove(env); env.player.advance(16);
    assert.equal(env.player.pauses, pauses); assert.equal(env.timers.size, 0); assert.equal(env.controller.getState().status, 'idle');
  }
  const env = setup(); env.controller.dispose(); assert.equal(await env.controller.listen(range), false);
});

test('snapshots are immutable and caller mutation cannot alter playback bounds', async () => {
  const env = setup(), input = {...range}; await env.controller.listen(input); input.end = 100;
  const state = env.controller.getState(); assert.throws(() => { state.range.end = 100; }, TypeError);
  assert.throws(() => { state.returnPosition.time = 1; }, TypeError);
  env.player.advance(14); assert.equal(env.controller.getState().status, 'finished');
});
