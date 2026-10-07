/** Build-time only. Seal fresh development bundles; never re-sign installed apps. */
import {sign} from '@electron/osx-sign';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {validateFreshMacBundle,within} from './mac-bundle-tree.mjs';
const execute=promisify(execFile);

export async function verifyMacBundle(app) {
  await execute('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app]);
  const {stderr}=await execute('/usr/bin/codesign',['--display','--verbose=2',app]);
  if(!stderr.includes('Identifier=io.github.yakihugo.coconut\n') || !/Sealed Resources version=2\b/.test(stderr))throw new Error('Coconut bundle identity or resource seal is missing');
  return stderr;
}

export async function signDevelopmentBundle(app,{buildRoot,electronVersion}) {
  if(process.platform!=='darwin')throw new Error('macOS development signing requires native macOS');
  const actual=await validateFreshMacBundle(app,buildRoot);
  const resources=path.join(actual,'Contents','Resources');
  // The audited PyInstaller helper already has a valid ad-hoc signature. Keep
  // its pinned bytes/receipt intact. Data (ASAR, archives, notices) is sealed as
  // resources rather than treated as extra executable code by osx-sign's walk.
  await sign({app:actual,platform:'darwin',version:electronVersion,identity:'-',identityValidation:false,
    type:'development',preAutoEntitlements:false,preEmbedProvisioningProfile:false,strictVerify:true,
    ignore:file=>within(resources,file),
    // Ad-hoc identities have no Team ID. Hardened runtime's library validation
    // requires a matching trusted team for Electron Framework; use the normal
    // development configuration without granting disable-library-validation.
    // Developer ID distribution is a separate identity + hardened-runtime path.
    optionsForFile:()=>({entitlements:['com.apple.security.cs.allow-jit'],hardenedRuntime:false,timestamp:'none'})});
  const details=await verifyMacBundle(actual);
  if(!details.includes('Signature=adhoc\n')||!details.includes('TeamIdentifier=not set\n'))throw new Error('Development build unexpectedly used a signing identity');
}
