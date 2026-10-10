(function (root) {
  'use strict';

  // A temporary range on the existing player, not another media element. Call
  // cancel() before ordinary seeking or cue-loop playback takes ownership.
  function create({getPlayer, getDocumentKey, onChange = () => {}, onTakeover = () => {},
    setTimer = (callback, delay) => root.setTimeout(callback, delay),
    clearTimer = handle => root.clearTimeout(handle)} = {}) {
    if (typeof getPlayer !== 'function' || typeof getDocumentKey !== 'function') {
      throw new TypeError('Passage playback requires a player and document lookup');
    }
    let session = null, timer = null, revision = 0, disposed = false, lastError = '';
    const source = player => player?.getAttribute?.('src') || player?.currentSrc || player?.src || '';
    const sameSource = target => target && getPlayer() === target.player &&
      getDocumentKey() === target.key && source(target.player) === target.source;
    const snapshot = () => Object.freeze({
      status: session?.status || (lastError ? 'error' : 'idle'),
      range: session ? Object.freeze({...session.range}) : null,
      returnPosition: session ? Object.freeze({...session.origin}) : null,
      error: lastError,
    });
    const publish = () => onChange(snapshot());
    function clearClock() { if (timer !== null) clearTimer(timer); timer = null; }
    function release() {
      clearClock(); revision++;
      if (session) for (const [name, handler] of session.listeners) session.player.removeEventListener(name, handler);
      session = null;
    }
    function cancel(reason) {
      const changed = !!session || !!lastError;
      release(); lastError = '';
      if (reason === 'takeover') onTakeover();
      if (changed) publish();
    }
    function sync() {
      if (session && !sameSource(session)) cancel();
      return snapshot();
    }
    function valid(target) {
      if (disposed || session !== target) return false;
      if (!sameSource(target)) { cancel(); return false; }
      return true;
    }
    function quietDetachedPlayer(target) {
      // A delayed play() completion belongs to its original element. Never
      // pause a current/reused player that a newer action may now be using.
      if (getPlayer() !== target.player && source(target.player) === target.source) target.player.pause();
    }
    function fail(target, message) {
      if (!valid(target)) return;
      clearClock(); target.status = 'error'; lastError = message;
      target.player.pause(); publish();
    }
    function seek(target, time) {
      // Browsers dispatch seeking/seeked asynchronously. An expected seek is
      // consumed by seeked; any different destination releases our ownership.
      target.expectedSeek = time;
      target.player.currentTime = time;
    }
    function finish(target) {
      if (!valid(target) || target.status === 'finished' || target.status === 'error') return;
      clearClock(); target.status = 'finished';
      target.player.pause();
      try { if (target.player.currentTime !== target.range.end) seek(target, target.range.end); }
      catch { fail(target, '媒体暂时无法定位到这段结尾，请检查播放器。'); return; }
      publish();
    }
    function schedule(target) {
      clearClock();
      if (!valid(target) || target.player.paused || !['loading', 'playing'].includes(target.status)) return;
      const rate = target.player.playbackRate > 0 ? target.player.playbackRate : 1;
      const remaining = (target.range.end - target.player.currentTime) / rate;
      // timeupdate can be sparse. This clock tightens the end boundary while
      // playing; it does not claim sample-accurate cuts or run when paused.
      timer = setTimer(() => { timer = null; observe(target); }, Math.max(16, Math.min(250, remaining * 1000)));
    }
    function observe(target) {
      if (!valid(target)) return;
      if (target.status === 'finished' || target.status === 'error') return;
      if (target.player.currentTime >= target.range.end) { finish(target); return; }
      if (target.player.currentTime < target.range.start - .03 && target.expectedSeek === null) { cancel(); return; }
      schedule(target);
    }
    function attach(target) {
      const listen = (name, handler) => {
        const guarded = event => { if (valid(target)) handler(event); };
        target.listeners.push([name, guarded]); target.player.addEventListener(name, guarded);
      };
      listen('timeupdate', () => observe(target));
      listen('ended', () => {
        if (target.player.currentTime >= target.range.end - .03) finish(target);
        else fail(target, '媒体在这段结束前停止了，请检查原文件与时间范围。');
      });
      listen('seeking', () => {
        if (target.expectedSeek === null || Math.abs(target.player.currentTime - target.expectedSeek) > .03) cancel('takeover');
      });
      listen('seeked', () => {
        if (target.expectedSeek !== null && Math.abs(target.player.currentTime - target.expectedSeek) > .03) { cancel('takeover'); return; }
        target.expectedSeek = null; observe(target);
      });
      listen('play', () => {
        // Pressing the ordinary Play control after a completed preview means
        // normal playback, not an invisible range that immediately stops it.
        if (target.status === 'finished' || target.status === 'error') { cancel(); return; }
        target.status = 'playing'; publish(); schedule(target);
      });
      listen('pause', () => {
        clearClock();
        if (['loading', 'playing'].includes(target.status)) { target.status = 'paused'; publish(); }
      });
      listen('ratechange', () => schedule(target));
      listen('durationchange', () => {
        if (!Number.isFinite(target.player.duration) || target.player.duration < target.range.end) {
          fail(target, '媒体时长已变化，这段时间超出原声范围。');
        }
      });
      listen('error', () => fail(target, '媒体暂时无法播放，请检查原文件。'));
      listen('emptied', cancel);
      listen('loadstart', cancel);
    }
    async function listen(range) {
      if (disposed) return false;
      sync();
      const player = getPlayer(), key = getDocumentKey();
      if (!player || player.error || key == null || !Number.isFinite(player.duration) || player.duration <= 0 ||
        !Number.isFinite(range?.start) || !Number.isFinite(range?.end) || range.start < 0 ||
        range.end <= range.start || range.end > player.duration) {
        // Invalid requests never interrupt a valid preview or move the player.
        if (!session) { lastError = '请等待媒体加载，并确认这段时间在原声范围内。'; publish(); }
        return false;
      }
      const origin = session ? {...session.origin} : {
        time: Number.isFinite(player.currentTime) ? Math.max(0, Math.min(player.duration, player.currentTime)) : 0,
        wasPlaying: !player.paused && !player.ended,
      };
      release(); lastError = ''; player.pause();
      const target = {player, key, source: source(player), origin, status: 'loading', expectedSeek: null, listeners: [],
        range: {id: String(range.id || ''), start: range.start, end: range.end, label: String(range.label || '')}};
      session = target; attach(target); publish();
      try {
        seek(target, target.range.start);
        await player.play();
        if (!valid(target)) { quietDetachedPlayer(target); return false; }
        // Very short ranges can finish before the original play promise settles.
        if (!['finished', 'error'].includes(target.status)) {
          target.status = player.paused ? 'paused' : 'playing'; publish(); observe(target);
        }
        return true;
      } catch (error) {
        if (!valid(target)) return false;
        // pause() at the boundary can abort a still-pending play promise. The
        // completed passage remains completed, and a user's pause stays paused.
        if (target.status === 'finished') return true;
        if (target.status === 'paused' && error?.name === 'AbortError') return false;
        fail(target, error?.name === 'NotAllowedError' ? '浏览器未允许播放，请点击“再听一次”重试。' : '这段原声暂时无法播放，请检查播放器后重试。');
        return false;
      }
    }
    async function replay() {
      sync(); return session ? listen(session.range) : false;
    }
    async function normalPlayback(returning) {
      sync(); const target = session;
      if (!target || disposed) return false;
      const player = target.player, origin = {...target.origin};
      cancel(); const operation = revision;
      try {
        if (returning) { player.pause(); player.currentTime = Math.min(origin.time, player.duration); }
        onTakeover();
        if (!returning || origin.wasPlaying) await player.play();
        if (disposed || operation !== revision || !sameSource(target)) { quietDetachedPlayer(target); return false; }
        return true;
      } catch {
        if (!disposed && operation === revision && sameSource(target)) {
          lastError = '媒体暂时无法继续播放，请检查播放器后重试。'; publish();
        }
        return false;
      }
    }
    return Object.freeze({listen, replay, continue: () => normalPlayback(false), returnToPrevious: () => normalPlayback(true),
      cancel, sync, getState: sync, dispose() { if (!disposed) { disposed = true; cancel(); } }});
  }
  const api = {create};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CoconutPassagePlayback = api;
})(typeof window !== 'undefined' ? window : globalThis);
