#!/usr/bin/env node
/** Rules first. Optional bounded CLI fallback is always an explicit choice. */
import {readFile,writeFile,mkdir,stat,realpath,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {createCleanReadingPlanner} from '../desktop/clean-reading.mjs';
const [input,output,...args]=process.argv.slice(2),options={};
const usage='Usage: node scripts/prepare-clean-reading.mjs SOURCE.json NEW_READING.json [--audio FILE] [--work DIR] [--fallback codex] [--model ID] [--python PATH]';
if(!input||!output||path.resolve(input)===path.resolve(output))throw Error(usage);
for(let i=0;i<args.length;i+=2){if(!['--audio','--work','--fallback','--model','--python'].includes(args[i])||!args[i+1]||Object.hasOwn(options,args[i]))throw Error(usage);options[args[i]]=args[i+1];}
if(options['--fallback']&&options['--fallback']!=='codex'||options['--model']&&!options['--fallback'])throw Error(usage);
const sourceStat=await stat(input),outputStat=await stat(output).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
if(outputStat&&sourceStat.dev===outputStat.dev&&sourceStat.ino===outputStat.ino||await realpath(output).catch(()=>null)===await realpath(input))throw Error('Output aliases the source document; original retained');
const bytes=await readFile(input),doc=JSON.parse(bytes);doc.key||='local-reading-'+createHash('sha256').update(bytes).digest('hex').slice(0,16);
const python=options['--python']||process.env.COCONUT_CLEANUP_PYTHON||process.env.COCONUT_READING_PYTHON||'python3';
const planner=createCleanReadingPlanner({python});
const result=await planner.prepare(doc,{directory:path.resolve(options['--work']||output+'.work'),provider:options['--fallback']||'',model:options['--model']||'',audioPath:options['--audio']?path.resolve(options['--audio']):null,
 onProgress:value=>process.stderr.write(JSON.stringify(value)+'\n')});
const final={...doc,reading_cleanup:{...result.reading_cleanup,provenance:{...result.reading_cleanup.provenance,input_sha256:createHash('sha256').update(bytes).digest('hex')}}};
if(JSON.stringify(final.segments)!==JSON.stringify(doc.segments))throw Error('Reading output changed source text or clocks');
await mkdir(path.dirname(path.resolve(output)),{recursive:true});const temporary=output+'.'+randomUUID()+'.tmp';
await writeFile(temporary,JSON.stringify(final,null,2)+'\n',{mode:0o600});await rename(temporary,output);
console.log(JSON.stringify({output,cues:doc.segments.length,...final.reading_cleanup.stats,sourceUnchanged:true}));
