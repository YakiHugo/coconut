import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateFreshMacBundle} from '../desktop/mac-bundle-tree.mjs';
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-sign-boundary-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const buildRoot=path.join(directory,'build'),app=path.join(buildRoot,'Coconut.app'),outside=path.join(directory,'outside');
  await fs.mkdir(path.join(app,'Contents'),{recursive:true});await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'authored.cstemp'),'Never mutate this external file');
  return {directory,buildRoot,app,outside};
}
test('signing preflight rejects linked Contents without touching external files',async t=>{
  const s=await fixture(t);await fs.rmdir(path.join(s.app,'Contents'));await fs.symlink(s.outside,path.join(s.app,'Contents'));
  await assert.rejects(validateFreshMacBundle(s.app,s.buildRoot),/real directory/);
  assert.equal(await fs.readFile(path.join(s.outside,'authored.cstemp'),'utf8'),'Never mutate this external file');
});
test('signing preflight rejects nested file and directory links outside the application',async t=>{
  const s=await fixture(t),linked=path.join(s.app,'Contents','external');
  for(const target of [s.outside,path.join(s.outside,'authored.cstemp')]) {
    await fs.symlink(target,linked);await assert.rejects(validateFreshMacBundle(s.app,s.buildRoot),/symlink escapes/);await fs.unlink(linked);
  }
  assert.equal(await fs.readFile(path.join(s.outside,'authored.cstemp'),'utf8'),'Never mutate this external file');
});
test('signing preflight preserves normal internal Framework links',async t=>{
  const s=await fixture(t),framework=path.join(s.app,'Contents/Frameworks/Authored.framework');
  await fs.mkdir(path.join(framework,'Versions/A'),{recursive:true});await fs.writeFile(path.join(framework,'Versions/A/Authored'),'inert fixture');
  await fs.symlink('A',path.join(framework,'Versions/Current'));await fs.symlink('Versions/Current/Authored',path.join(framework,'Authored'));
  assert.equal(await validateFreshMacBundle(s.app,s.buildRoot),await fs.realpath(s.app));
});
test('signing preflight rejects a linked app and an app outside the declared build',async t=>{
  const s=await fixture(t),alias=path.join(s.buildRoot,'alias');await fs.mkdir(alias);await fs.symlink(s.app,path.join(alias,'Coconut.app'));
  await assert.rejects(validateFreshMacBundle(path.join(alias,'Coconut.app'),s.buildRoot),/escape/);
  await assert.rejects(validateFreshMacBundle(s.app,s.outside),/restricted/);
});
