import type {Decision} from '@coconut/reader/disfluency.js';
import type {ReaderCue} from './contracts';

const closeQuote:Record<string,string>={'“':'”','「':'」','『':'』','‘':'’','"':'"'};

export function spokenReadingEdits(cues:ReaderCue[]):Decision[] {
    const decisions:Decision[]=[];
    const quotes:string[]=[];
    let previous:ReaderCue|undefined;
    for(const cue of cues) {
        const speaker=cue.speaker_id||cue.speaker;
        if(!previous||speaker!==(previous.speaker_id||previous.speaker)||cue.start-previous.end>2)quotes.length=0;
        previous=cue;
        const quoted:Array<{from:number;to:number}>=[];
        let start=quotes.length?0:-1;
        for(const match of cue.text.matchAll(/["“”「」『』‘’]/gu)) {
            const mark=match[0];
            if(quotes.at(-1)===mark) {
                quotes.pop();
                if(!quotes.length){quoted.push({from:start,to:match.index+1});start=-1;}
            } else if(closeQuote[mark]) {
                if(!quotes.length)start=match.index;
                quotes.push(closeQuote[mark]);
            }
        }
        if(start>=0)quoted.push({from:start,to:cue.text.length});
        const restart=cue.text.match(/^([我你他她])\1(?=(?:觉得|想|认为|问|说))/u);
        if(restart&&!quoted.some(range=>range.from===0))decisions.push({cue_id:cue.id,from:0,to:1,action:'hide',reason:'immediate_restart'});
        // Only remove explicit, internal hesitation followed by real speech.
        // Initial acknowledgements, questions and quoted speech stay intact.
        for(const match of cue.text.matchAll(/(?<=[，,、])\s*[呃嗯]+[，,、]\s*(?!(?:是|对|好的|同意))(?=\p{L})/gu)) {
            const from=match.index,to=from+match[0].length;
            if(!quoted.some(range=>from<range.to&&range.from<to))decisions.push({cue_id:cue.id,from,to,action:'hide',reason:'filled_pause'});
        }
    }
    return decisions;
}
