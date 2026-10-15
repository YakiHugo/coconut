/** Small, explicit publisher catalog. No tracking, prefetched feeds or ranking. */
export const podcastCatalog = [
    {id:'ted-daily',title:'TED Talks Daily',description:'观点与创意 · 英语',feed:'https://feeds.acast.com/public/shows/ttd',source:'https://shows.acast.com/ttd',tags:'TED ideas talks 观点 创意'},
    {id:'lex-fridman',title:'Lex Fridman Podcast',description:'科技与长对话 · 英语',feed:'https://lexfridman.com/feed/podcast/',source:'https://lexfridman.com/podcast',tags:'Lex technology science 科技 科学 对话'},
] as const;
export const searchCatalog=(query:string)=>podcastCatalog.filter(show=>`${show.title} ${show.description} ${show.tags}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
