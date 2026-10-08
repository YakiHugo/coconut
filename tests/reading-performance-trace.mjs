/** Optional one-run CI diagnostics on authored input; no performance thresholds. */
import fs from 'node:fs/promises';
import path from 'node:path';
const DEADLINE_MS = 20000, CLEANUP_MS = 3000;
function bounded(promise, deadline, stage) {
  let timer;
  if (Date.now() >= deadline) {Promise.resolve(promise).catch(() => {}); return Promise.reject(new Error(stage + ' exceeded diagnostic capture deadline'));}
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(stage + ' exceeded diagnostic capture deadline')), Math.max(0, deadline - Date.now()));
  })]).finally(() => clearTimeout(timer));
}
export async function startReadingPerformanceTrace(page, directory, {deadlineMs = DEADLINE_MS, cleanupMs = CLEANUP_MS} = {}) {
  if (!directory) return null;
  if (process.env.CI !== 'true') throw new Error('Reading performance tracing is CI-only');
  let session, stream, stopping, completionListener, initialized = false;
  const errors = [];
  const failure = (stage, error) => errors.push({stage, message: error?.message || String(error)});
  async function cleanup() {
    if (!session) return;
    if (completionListener) session.off('Tracing.tracingComplete', completionListener);
    const deadline = Date.now() + cleanupMs;
    try {if (stream) await bounded(session.send('IO.close', {handle: stream}), deadline, 'close trace stream');}
    catch (error) {failure('cleanup stream', error);}
    try {await bounded(session.detach(), deadline, 'detach trace session');}
    catch (error) {failure('cleanup session', error);}
    session = null;
  }
  async function stop() {
    const deadline = Date.now() + deadlineMs;
    let observations;
    try {
      if (!initialized) return;
      // A wedged renderer must not keep product cleanup waiting indefinitely.
      try {observations = await bounded(page.evaluate(() => window.__readingPerformanceEntries?.() || null), deadline, 'read performance entries');}
      catch (error) {failure('read performance entries', error);}
      const completed = new Promise(resolve => {completionListener = resolve; session.once('Tracing.tracingComplete', completionListener);});
      await bounded(session.send('Tracing.end'), deadline, 'end trace');
      ({stream} = await bounded(completed, deadline, 'wait for trace completion'));
      if (!stream) throw new Error('Trace completion did not provide a stream');
      const chunks = [];
      for (;;) {
        const {data, base64Encoded, eof} = await bounded(session.send('IO.read', {handle: stream}), deadline, 'read trace stream');
        chunks.push(base64Encoded ? Buffer.from(data, 'base64') : Buffer.from(data));
        if (eof) break;
      }
      await bounded(fs.writeFile(path.join(directory, 'authored-reading-chromium-trace.json'), Buffer.concat(chunks)), deadline, 'write trace');
      await bounded(fs.writeFile(path.join(directory, 'authored-reading-observations.json'), JSON.stringify({
        scope: 'CI Chromium on authored 1,771-cue workflow; not a Mac measurement or an INP field metric. User timing marks delimit automation steps, not event latency. Missing entries do not mean zero latency.',
        browserVersion: page.context().browser().version(), observations,
      }, null, 2)), deadline, 'write observations');
      if (!observations) failure('read performance entries', new Error('No performance observations were available'));
    } catch (error) {failure('stop capture', error);}
    finally {await cleanup();}
  }
  async function finish() {
    await stop();
    const result = {status: errors.length ? 'failed' : 'passed', errors};
    try {await bounded(fs.writeFile(path.join(directory, 'authored-reading-capture-status.json'), JSON.stringify(result, null, 2)), Date.now() + cleanupMs, 'write capture status');}
    catch (error) {failure('write capture status', error); result.status = 'failed';}
    console.log(JSON.stringify({suite: 'authored-reading-performance-capture', ...result}));
    return result;
  }
  const collector = {
    async mark(label) {
      if (!initialized || stopping) return;
      try {await bounded(page.evaluate(label => performance.mark('coconut-authored:' + label), label), Date.now() + cleanupMs, 'write phase mark');}
      catch (error) {failure('phase mark ' + label, error);}
    },
    stop() {return stopping ??= finish();},
  };
  try {
    const deadline = Date.now() + deadlineMs;
    await bounded(fs.mkdir(directory, {recursive: true}), deadline, 'create diagnostics directory');
    await bounded(page.addInitScript(() => {
      const entries = {longtask: [], event: []}, observers = [];
      for (const type of Object.keys(entries)) {
        if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) entries[type].push(entry.toJSON());
        });
        observer.observe({type, buffered: true, ...(type === 'event' ? {durationThreshold: 16} : {})});
        observers.push({type, observer});
      }
      window.__readingPerformanceEntries = () => {
        for (const {type, observer} of observers) {
          for (const entry of observer.takeRecords()) entries[type].push(entry.toJSON());
        }
        return {entries, marks: performance.getEntriesByType('mark').map(entry => entry.toJSON()), timeOrigin: performance.timeOrigin, supportedEntryTypes: PerformanceObserver.supportedEntryTypes};
      };
    }), deadline, 'install performance observers');
    // If admission resolves after timeout, detach that late session as well.
    const admission = page.context().newCDPSession(page);
    try {session = await bounded(admission, deadline, 'attach trace session');}
    catch (error) {admission.then(late => bounded(late.detach(), Date.now() + cleanupMs, 'detach late session')).catch(() => {}); throw error;}
    await bounded(session.send('Tracing.start', {
      categories: 'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline',
      transferMode: 'ReturnAsStream',
    }), deadline, 'start trace');
    initialized = true;
  } catch (error) {failure('start capture', error); await cleanup();}
  return collector;
}
