import type {Decision} from '@coconut/reader/disfluency.js';
import type {ReaderCue} from './contracts';

const quoteEnds:Record<string,string>={'“':'”','「':'」','『':'』','‘':'’','"':'"'};
const pauses=/[嗯呃]+(?:[，,\s]*[嗯呃]+)*/gu;
const restarts=/(我觉得|我覺得|我们|我們|所以|然后|然後|因为|因為|但是|就是|其实|其實|我|你|他|她)(?:[，,\s]*\1)+/gu;

export function spokenReadingEdits(cues:ReaderCue[]):Decision[] {
    const decisions:Decision[]=[],quotes:string[]=[];
    for(const [index,cue] of cues.entries()){
        const text=cue.text,protectedRanges:Array<[number,number]>=[];
        let quotedFrom=quotes.length?0:-1;
        for(const match of text.matchAll(/["“”「」『』‘’]/gu)){
            const symbol=match[0];
            if(quotes.at(-1)===symbol){
                quotes.pop();
                if(!quotes.length){protectedRanges.push([quotedFrom,match.index+1]);quotedFrom=-1;}
            }else if(quoteEnds[symbol]){
                if(!quotes.length)quotedFrom=match.index;
                quotes.push(quoteEnds[symbol]);
            }
        }
        if(quotedFrom>=0)protectedRanges.push([quotedFrom,text.length]);
        if(!/[嗯呃我你他她所然因但就其]/u.test(text)||(text.match(/[\p{L}\p{N}]/gu)?.length||0)<=5)continue;
        const hides:Array<[number,number,string]>=[];
        for(const match of text.matchAll(pauses)){
            let from=match.index,to=from+match[0].length;
            if(/[哼呐哪哈逆]/u.test(text.charAt(to))||/^\s*[？?!！]/u.test(text.slice(to)))continue;
            const previous=cues[index-1],voice=cue.speaker_id||cue.speaker;
            if(!from&&match[0][0]==='嗯'&&(!voice||!previous||voice!==(previous.speaker_id||previous.speaker)||cue.start-previous.end>2)){
                from++;while(from<to&&/[，,\s]/u.test(text[from]))from++;
            }
            if(from>=to)continue;
            const left=text.charAt(from-1),right=text.charAt(to);
            if(/[，,、]/u.test(left)&&(!right||/[，,、。.!！？?；;：:]/u.test(right)))from--;
            else if(/[，,、]/u.test(right)&&(!left||/[，,。.!！？?；;：:]/u.test(left)))to++;
            hides.push([from,to,'filled_pause']);
        }
        for(const match of text.matchAll(restarts)){
            if(/^(?:[我你他她]|我们|我們)$/u.test(match[1])&&match[0].replace(/[，,\s]/gu,'').length===2*match[1].length&&match.index>0&&
                !/[嗯呃，,。.!！？?；;：:\s]/u.test(text[match.index-1]))continue;
            hides.push([match.index,match.index+match[0].length-match[1].length,'immediate_restart']);
        }
        for(const [from,to,reason] of hides.sort((left,right)=>left[0]-right[0])){
            if(protectedRanges.some(([start,end])=>from<end&&to>start))continue;
            const prior=decisions.at(-1);
            if(prior?.cue_id===cue.id&&prior.to>=from)prior.to=Math.max(prior.to,to);
            else decisions.push({cue_id:cue.id,from,to,reason,action:'hide'});
        }
    }
    return decisions;
}
