import type {Episode} from './ingestion';
/** Search only the bounded publisher list; never imply an archive/network search. */
export function filterEpisodes(episodes:Episode[],query:string):Episode[]{
    const needle=query.trim().toLocaleLowerCase();
    return needle?episodes.filter(episode=>episode.title.toLocaleLowerCase().includes(needle)):episodes;
}
export function episodeMetadata(episode:Episode):string{
    const parts:string[]=[];
    if(episode.published){const date=new Date(episode.published);if(!Number.isNaN(date.getTime()))parts.push(date.toLocaleDateString());}
    if(typeof episode.duration==='number'&&Number.isFinite(episode.duration)&&episode.duration>0){
        const seconds=Math.floor(episode.duration),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
        parts.push('时长 '+(hours?`${hours}:${String(minutes).padStart(2,'0')}`:String(minutes))+':'+String(seconds%60).padStart(2,'0'));
    }
    return parts.join(' · ');
}
