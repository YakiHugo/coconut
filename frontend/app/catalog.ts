/** Small, explicit publisher catalog. No tracking, prefetched feeds or ranking. */
export const podcastCatalog = [
    {id:'podcasting-2',title:'Podcasting 2.0',description:'播客技术 · 英语 · 发布者带时文字稿，未校对；按单集检查',feed:'https://mp3s.nashownotes.com/pc20rss.xml',source:'https://mp3s.nashownotes.com/pc20rss.xml',tags:'podcast technology transcript 播客 技术 文字稿 字幕'},
    {id:'ted-daily',title:'TED Talks Daily',description:'观点与创意 · 英语 · 文字稿以单集检查为准',feed:'https://feeds.acast.com/public/shows/ttd',source:'https://shows.acast.com/ttd',tags:'TED ideas talks 观点 创意'},
    {id:'lex-fridman',title:'Lex Fridman Podcast',description:'科技与长对话 · 英语 · 文字稿以单集检查为准',feed:'https://lexfridman.com/feed/podcast/',source:'https://lexfridman.com/podcast',tags:'Lex technology science 科技 科学 对话'},
] as const;
export const searchCatalog=(query:string)=>podcastCatalog.filter(show=>`${show.title} ${show.description} ${show.tags}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
