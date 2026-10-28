import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mountedSourceApp, wait} from './helpers/mounted-source-app.mjs';

const output = await build({entryPoints:['frontend/app/source-link.ts'],bundle:true,format:'esm',write:false,platform:'node'});
const {parseSourceLink} = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
const video = 'https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy';

test('source composer extracts share links, preserves source parameters and recognizes host boundaries', () => {
    assert.deepEqual(parseSourceLink('【分享视频】值得重读的想法 ' + video + '。'), {url:video,label:'Bilibili'});
    assert.equal(parseSourceLink('(https://publisher.example/episode_(one))').url, 'https://publisher.example/episode_(one)');
    assert.equal(parseSourceLink('www.youtube.com/watch?v=abcdefghijk').label, 'YouTube');
    assert.equal(parseSourceLink('https://youtube.com.evil.example/feed').label, '播客 / 链接');
    assert.equal(parseSourceLink('https://publisher.example/audio.MP3?download=1').label, '音视频');
    assert.equal(parseSourceLink('https://publisher.example/feed?token=abc!').url, 'https://publisher.example/feed?token=abc!');
    assert.equal(parseSourceLink(video + '\n' + video).url, video);
    for (const value of ['', '没有链接', 'javascript:alert(1)', 'ftp://publisher.example/feed', 'https://user:password@publisher.example/feed', video + ' https://publisher.example/feed', 'https://' + 'a'.repeat(4096)]) {
        assert.equal(parseSourceLink(value), null, value);
    }
});

function paste(x, text) {
    const event = new x.w.Event('paste', {bubbles:true,cancelable:true});
    Object.defineProperty(event, 'clipboardData', {value:{getData:() => text}});
    x.w.document.querySelector('#source-url').dispatchEvent(event);
    return event;
}
const diagnostic = {stage:'metadata',reason:'subtitle_login_required',requests_attempted:2,responses_received:2};
const fixture = {service:{ingest:async () => ({protocolVersion:1,ingestion:{id:'failure',state:'blocked',source:{},error:{code:'login_required',message:'登录后才能获取字幕。保留服务端的完整说明。',diagnostic}}})}};

test('pasting share text extracts without fetching; submit reads the extracted link and folds diagnostics', async () => {
    const x = await mountedSourceApp(fixture);
    try {
        const event = paste(x, '推荐这个视频 ' + video + '。');
        await wait(() => x.w.document.querySelector('#source-url').value === video);
        assert.equal(event.defaultPrevented, true);
        assert.equal(x.requests.length, 0);
        assert.match(x.w.document.querySelector('.source-kind').textContent, /Bilibili/);
        assert.match(x.w.document.querySelector('.app-toast').textContent, /已识别/);
        x.w.document.querySelector('.source-composer').dispatchEvent(new x.w.Event('submit', {bubbles:true,cancelable:true}));
        await wait(() => x.w.document.querySelector('.source-feedback'));
        assert.equal(x.requests.length, 1);
        assert.equal(x.requests[0].source.url, video);
        assert.equal(x.w.document.querySelector('.source-diagnostics').open, false);
        assert.match(x.w.document.querySelector('.source-feedback h2').textContent, /登录/);
        assert.match(x.w.document.querySelector('[data-caption-diagnostic]').textContent, /尝试请求 2 次/);
        x.w.document.querySelector('.app-toast button').click();
        await wait(() => !x.w.document.querySelector('.app-toast'));
        assert.ok(x.button('重试上次读取'), 'recovery remains available after dismissing the toast');
        assert.equal(x.w.document.querySelector('#source-url').value, video);
        assert.equal(x.docs().length, 0);
    } finally {await x.w.happyDOM.close();}
});

test('invalid or ambiguous input only shows a toast and never submits a source', async () => {
    const x = await mountedSourceApp(fixture);
    try {
        for (const value of ['这不是链接', video + ' https://publisher.example/feed']) {
            x.open(value);
            await wait(() => x.w.document.querySelector('.app-toast'));
            assert.match(x.w.document.querySelector('.app-toast').textContent, /一个有效/);
            assert.equal(x.requests.length, 0);
            assert.equal(x.w.document.querySelector('#source-url').value, value);
        }
    } finally {await x.w.happyDOM.close();}
});

test('a repeated submit cannot cancel and restart an in-flight source request', async () => {
    let release;
    const held = new Promise(resolve => release = resolve);
    const x = await mountedSourceApp({service:{ingest:async (...args) => {await held;return fixture.service.ingest(...args);}}});
    try {
        x.open(video);
        await wait(() => x.button('取消读取'));
        x.w.document.querySelector('.source-composer').dispatchEvent(new x.w.Event('submit', {bubbles:true,cancelable:true}));
        assert.equal(x.requests.length, 1);
        x.button('取消读取').click();release();
        await wait(() => !x.button('取消读取'));
        assert.equal(x.docs().length, 0);
    } finally {release();await x.w.happyDOM.close();}
});
