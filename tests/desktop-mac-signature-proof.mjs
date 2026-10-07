/** Verify exact release ZIP seals and prove that post-signing changes are rejected. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {verifyMacBundle} from '../desktop/mac-signing.mjs';
const execute=promisify(execFile);
assert.equal(process.platform,'darwin','Signature proof requires native macOS');
const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(await fs.readFile(path.join(root,'desktop/package.json'),'utf8'));
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-mac-signature-proof-'));
const checks=[];
try {
  for(const arch of ['arm64','x64']) {
    const directory=path.join(temporary,arch);await fs.mkdir(directory);
    await execute('/usr/bin/ditto',['-x','-k',path.join(root,'desktop/dist',`Coconut-${version}-${arch}-unsigned.zip`),directory]);
    const app=path.join(directory,'Coconut.app');
    const details=await verifyMacBundle(app);
    assert.match(details,/Signature=adhoc\n/);assert.match(details,/TeamIdentifier=not set\n/);
    const resources=path.join(app,'Contents/Resources');
    await execute('/usr/bin/codesign',['--verify','--strict','--verbose=2',path.join(resources,'caption-helper/coconut-caption')]);
    checks.push(arch+'_exact_zip_complete_adhoc_signature');
    checks.push(arch+'_pinned_helper_signature_valid');
    const stylesheet=path.join(resources,'reader/style.css'),original=await fs.readFile(stylesheet);
    await fs.appendFile(stylesheet,'\n/* authored tamper proof */\n');
    await assert.rejects(verifyMacBundle(app));checks.push(arch+'_changed_reader_resource_rejected');
    await fs.writeFile(stylesheet,original);await verifyMacBundle(app);
    const helper=path.join(resources,'caption-helper/coconut-caption'),helperBytes=await fs.readFile(helper);
    helperBytes[Math.floor(helperBytes.length/2)]^=1;await fs.chmod(helper,0o700);await fs.writeFile(helper,helperBytes);
    await assert.rejects(verifyMacBundle(app));checks.push(arch+'_changed_native_helper_rejected');
  }
  console.log(JSON.stringify({ok:true,version,checks,signature:'adhoc',developerId:false,notarized:false,gatekeeperAccepted:false}));
}finally{await fs.rm(temporary,{recursive:true,force:true});}
