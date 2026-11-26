import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startDevelopmentBridge} from '../desktop/dev.mjs';

const directory=await mkdtemp(join(tmpdir(),'coconut-reading-position-'));
const documents=['one','two'].map(key=>({
    key,title:'Reading position '+key,notes:{},language:'en',
    ...(key==='one'?{source_url:'https://publisher.example/reading-position',podcast_source:{kind:'direct_media',media_url:'https://publisher.example/reading-position.wav',media_kind:'audio'}}:{}),
    segments:Array.from({length:80},(_,i)=>({
        id:`cue-${i}`,start:i*3,end:i*3+3,speaker:`Speaker ${i===31||i===32?3:i===35?2:i%2}`,
        text:`Passage ${i}. `+'Follow the argument through the rest of this passage. '.repeat(i===35?40:2).trim(),
    })),
}));
const spokenWords=['First ', 'sentence. ', 'Second ', 'sentence. ', 'Third ', 'sentence.'];
const spokenCue=documents[0].segments[40];
spokenCue.text=spokenWords.join('');
spokenCue.words=spokenWords.map((word,i)=>({word,start:120+i*.5,end:120+(i+1)*.5}));
spokenCue.timing_basis='word';spokenCue.alignment_status='complete';
const wav=Buffer.alloc(44+248*16000);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);
wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
let server,browser;
try {
    ({server}=await startDevelopmentBridge({port:0,libraryDirectory:directory,taskDirectory:null,captionPython:null,captionProxy:null,privateProxy:null}));
    const origin='http://127.0.0.1:'+server.address().port;
    const {epoch}=await (await fetch(origin+'/api/v1/library')).json();
    for(const document of documents){
        const response=await fetch(origin+'/api/v1/library/commit',{
            method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
            body:JSON.stringify({protocolVersion:1,epoch,action:'put',key:document.key,receiptKey:'position-'+document.key,expected:null,document}),
        });
        assert.ok(response.ok,await response.text());
    }
    const executablePath=process.env.COCONUT_CHROMIUM_EXECUTABLE;
    browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
    const page=await browser.newPage({viewport:{width:1360,height:900}});
    await page.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.origin!==origin)return route.abort();
        if(url.pathname==='/api/podcasts/media')return route.fulfill({contentType:'audio/wav',body:wav});
        return route.continue();
    });
    const main=page.locator('#main-content');
    const scrollTop=()=>main.evaluate(node=>node.scrollTop||window.scrollY);
    const source=id=>page.locator(`[data-source-id="${id}"]`);
    const saved=key=>page.evaluate(key=>{
        const raw=localStorage.getItem('coconut-reading-view-defaults-v1');
        return JSON.parse(raw)?.views.find(view=>view[0]===key);
    },key);
    const distanceToFollowAnchor=target=>target.evaluate(node=>{
        const range=document.createRange();range.selectNodeContents(node);
        const line=[...range.getClientRects()].find(rect=>rect.width&&rect.height);
        const tabs=document.querySelector('.rw-content-switch').getBoundingClientRect();
        const player=document.querySelector('.rw-player')?.getBoundingClientRect();
        const top=tabs.bottom;
        const bottom=Math.min(innerHeight,player?.top??Infinity);
        return line?.top-(top+24+(bottom-top-48)/4);
    });
    const verifyRestored=async target=>{
        await expect(target).toBeInViewport();
        await expect.poll(async()=>Math.abs(await distanceToFollowAnchor(target))).toBeLessThan(4);
    };
    const scrollInside=async (id,distance)=>source(id).evaluate((node,distance)=>{
        node.dispatchEvent(new WheelEvent('wheel',{bubbles:true}));
        node.scrollIntoView({block:'start'});
        const tabs=document.querySelector('.rw-content-switch');
        const offset=node.getBoundingClientRect().top-tabs.getBoundingClientRect().bottom;
        const main=node.closest('main');
        const viewport=/^(auto|scroll)$/.test(getComputedStyle(main).overflowY)?main:window;
        viewport.scrollBy({top:offset+distance,behavior:'instant'});
    },distance);
    const open=async key=>{
        await page.getByRole('button',{name:/^我的内容/}).click();
        await page.getByRole('button',{name:new RegExp(`^Reading position ${key}`)}).click();
        await expect(page.getByRole('heading',{name:'Reading position '+key})).toBeVisible();
    };

    await page.goto(origin+'/#read/one');
    const long=source('cue-35');
    await expect(long).toHaveCount(1);
    await expect.poll(scrollTop).toBe(0);
    await scrollInside('cue-35',190);
    await expect.poll(()=>saved('one')).toEqual(['one','cue-35','passages']);
    await page.reload();
    await verifyRestored(long);

    await page.getByRole('tab',{name:'摘要'}).click();
    await page.getByRole('button',{name:'继续阅读全文'}).click();
    await verifyRestored(long);
    await page.getByRole('tab',{name:'摘要'}).click();
    await page.getByRole('tab',{name:'精读稿'}).click();
    await verifyRestored(long);
    await open('two');
    await expect.poll(scrollTop).toBe(0);
    await open('one');
    await verifyRestored(long);
    await page.getByRole('button',{name:/^我的内容/}).click();
    await page.goBack();
    await verifyRestored(long);

    assert.equal(await source('cue-32').evaluate(node=>node.closest('.rw-original').querySelector('[data-source-id]').dataset.sourceId),'cue-31');
    await scrollInside('cue-32',18);
    await page.reload();
    await verifyRestored(source('cue-31'));
    await page.setViewportSize({width:390,height:844});
    await page.reload();
    await verifyRestored(source('cue-31'));

    const load=page.getByRole('button',{name:'载入原声（最多 200 MiB）',exact:true});
    await load.click();
    const audio=page.locator('audio');
    await expect.poll(()=>audio.evaluate(node=>node.duration)).toBe(248);
    const seek=seconds=>audio.evaluate((node,time)=>{
        node.currentTime=time;node.dispatchEvent(new Event('timeupdate'));
    },seconds);
    await seek(121.25);
    const follow=page.getByRole('button',{name:'定位并跟随原声'});
    await follow.click();
    const sentence=source('cue-40').locator('[data-speech-from="16"]');
    await expect(sentence).toHaveClass(/rw-playing/);
    await expect.poll(()=>saved('one')).toEqual(['one','cue-40','passages',16]);
    await verifyRestored(sentence);

    // Playback owns progress even if the scroll to its sentence cannot finish.
    await main.evaluate(node=>{
        const viewport=/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)?node:window;
        const scrollBy=viewport.scrollBy;
        viewport.scrollBy=()=>{};
        window.addEventListener('wheel',()=>{viewport.scrollBy=scrollBy;},{once:true});
    });
    await seek(211.25);
    await expect.poll(()=>saved('one')).toEqual(['one','cue-70','passages']);
    await expect(source('cue-70')).not.toBeInViewport();
    // Manual scroll takes over, including during an unfinished follow jump.
    await page.mouse.move(120,220);
    await page.mouse.wheel(0,-160);
    await expect(follow).toHaveAttribute('aria-pressed','false');
    await scrollInside('cue-35',250);
    await expect.poll(()=>saved('one')).toEqual(['one','cue-35','passages']);
    await seek(121.25);
    await expect(sentence).toHaveClass(/rw-playing/);
    assert.deepEqual(await saved('one'),['one','cue-35','passages']);
    await follow.click();
    await expect.poll(()=>saved('one')).toEqual(['one','cue-40','passages',16]);
    await page.reload();
    await expect(audio).toHaveCount(1);
    await verifyRestored(sentence);
    assert.equal(await audio.evaluate(node=>node.paused),true);

    await main.evaluate(node=>{
        node.dispatchEvent(new WheelEvent('wheel',{bubbles:true}));
        const viewport=/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)?node:window;
        viewport.scrollTo({top:0,behavior:'instant'});
    });
    await expect.poll(()=>saved('one')).toEqual(['one','cue-0','passages']);
    await page.reload();
    await expect(long).toHaveCount(1);
    await expect.poll(scrollTop).toBe(0);
    assert.deepEqual(await saved('two'),['two','cue-0','passages']);

    // A stale saved cue falls back to the beginning of the current manuscript.
    await page.evaluate(()=>sessionStorage.setItem('coconut-reading-view-v1',JSON.stringify({version:2,views:[['one','removed-cue','passages',16]]})));
    await page.reload();
    await expect(source('cue-0')).toHaveClass(/rw-current/);
    await expect.poll(scrollTop).toBe(0);
    console.log('PASS shared reading position across paragraphs, playback sentences, handoff, and reload.');
} finally {
    await browser?.close();
    if(server)await new Promise(resolve=>server.shutdown(resolve));
    await rm(directory,{recursive:true,force:true});
}
