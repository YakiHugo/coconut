import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url);
function setup(stored){
  const window=new Window({url:'https://coconut.example/'});
  window.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
  Object.defineProperty(window,'crypto',{value:webcrypto});
  if(stored!==undefined)window.localStorage.setItem('coconut-reader-v1',stored);
  window.eval(fs.readFileSync(new URL('reader/core.js',root),'utf8'));
  window.eval(fs.readFileSync(new URL('reader/app.js',root),'utf8'));
  return window;
}
test('editing B does not redirect the open A note',async()=>{
  const w=setup();try{
    await w.document.getElementById('sample').onclick();
    let rows=w.document.querySelectorAll('.segment');rows[0].querySelectorAll('button')[1].click();
    const note=w.document.getElementById('note');note.value='First note';note.oninput();
    rows=w.document.querySelectorAll('.segment');rows[1].querySelector('button').click();
    w.document.getElementById('edit-segment').value='Corrected second segment';w.document.getElementById('save-edit').click();
    note.value='Still first note';note.oninput();
    const stored=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];
    assert.equal(stored.notes['demo-1'],'Still first note');assert.equal(stored.notes['demo-2'],undefined);
    assert.equal(stored.segments[1].text,'Corrected second segment');assert.ok(stored.segments[1].original_text);
  }finally{await w.happyDOM.close();}
});
test('damaged saved data remains intact while temporary reading works',async()=>{
  for(const original of ['{broken','{"unexpected":"data"}']){
    const w=setup(original);try{await w.document.getElementById('sample').onclick();
      assert.equal(w.localStorage.getItem('coconut-reader-v1'),original);
      assert.equal(w.document.querySelectorAll('.segment').length,3);
    }finally{await w.happyDOM.close();}
  }
});
test('notes survive restore and can be searched',async()=>{
  const first=setup();let stored;try{
    await first.document.getElementById('sample').onclick();
    first.document.querySelector('.segment').querySelectorAll('button')[1].click();
    const note=first.document.getElementById('note');note.value='My unique memory';note.oninput();
    stored=first.localStorage.getItem('coconut-reader-v1');
  }finally{await first.happyDOM.close();}
  const restored=setup(stored);try{
    const search=restored.document.getElementById('search');search.value='unique memory';search.oninput();
    assert.equal(restored.document.querySelectorAll('.segment').length,1);
    assert.equal(restored.document.querySelector('.saved-note').textContent,'My unique memory');
  }finally{await restored.happyDOM.close();}
});
