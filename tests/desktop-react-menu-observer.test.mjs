/** Test the authored observer itself; this is not native user-gesture proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('packaged observer records command-entry activation before the real chooser consumes it',()=>{
 const source=fs.readFileSync(new URL('./desktop-react-packaged-acceptance.mjs',import.meta.url),'utf8');
 const observer=source.match(/window\.coconutFileCommand=function\(command,request\)\{.*?return result;\};/);
 assert.ok(observer,'must exercise the actual packaged fixture observer');
 let active=true,calls=0;
 const window={authoredMenu:{sequence:0,last:null}};
 const context={window,navigator:{userActivation:{get isActive(){return active;}}},performance:{timeOrigin:10},Date:{now:()=>20},original:function(command,request){calls++;assert.equal(this,window);assert.equal(command,'open-local-media');assert.equal(request.issuedAt,15);active=false;return true;}};
 vm.runInNewContext(observer[0],context);
 assert.equal(window.coconutFileCommand('open-local-media',{issuedAt:15,expiresAt:30}),true);
 assert.equal(calls,1);assert.equal(window.authoredMenu.last.activation,true);assert.equal(window.authoredMenu.last.afterActivation,false);
 assert.equal(window.authoredMenu.last.current,true);assert.equal(window.authoredMenu.last.unexpired,true);assert.equal(window.authoredMenu.last.result,true);
});
