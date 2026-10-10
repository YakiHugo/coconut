import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {installSavePipeline} from './save-pipeline.mjs';
const root=new URL('../../',import.meta.url);
export function libraryHarness(documents=[],{probe=false,sourceRoot=root,configureCore=()=>{}}={}){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',sourceRoot),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 w.localStorage.setItem('coconut-reader-v1',JSON.stringify({documents,active:documents[0]?.key||null}));
 w.fetch=async()=>{throw Error('Unexpected network request');};
 for(const name of ['summary','core','passages','passage-playback'])w.eval(fs.readFileSync(new URL('reader/'+name+'.js',sourceRoot),'utf8'));
 configureCore(w);
 const pipeline=installSavePipeline(w);
 w.eval(['app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',sourceRoot),'utf8')).join('\n')+(probe?'\nwindow.libraryProbe={renderLibrary,render,get documents(){return state.documents;}};':''));
 w.HTMLElement.prototype.scrollIntoView=function(){};
 return {w,$:id=>w.document.getElementById(id),pipeline};
}
