import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {privateBrowserRecovery} from './helpers/private-backend-browser.mjs';
import {recoveryFixture} from './fixtures/canonical-migration.mjs';
const Coconut=createRequire(import.meta.url)('../reader/core.js');
test('private browser seed is a valid timed reader document without changing migration-only fixtures',()=>{
 const original=recoveryFixture(),recovery=privateBrowserRecovery();
 assert.throws(()=>Coconut.validate(original.stores.documents[0].value.payload),/时间戳/);
 const document=recovery.stores.documents[0].value.payload;
 assert.doesNotThrow(()=>Coconut.validate(document));
 assert.deepEqual(document.segments,[{id:'cue',text:'Original',start:0,end:3}]);
 assert.equal(document.notes.cue,'Private authored note');
 assert.deepEqual(recoveryFixture(),original);
});
