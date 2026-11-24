export async function openOriginal(page){
 await page.getByRole('button',{name:'来源与整理',exact:true}).click();
 await page.getByRole('dialog',{name:'来源与整理'}).getByRole('button',{name:'逐句原文',exact:true}).click();
}
