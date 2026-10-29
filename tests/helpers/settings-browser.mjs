import {readFile} from 'node:fs/promises';
export async function openSettings(page){const panel=page.locator('.app-settings');if(!await panel.evaluate(node=>node.open))await panel.locator(':scope>summary').click();}
export async function closeSettings(page){if(await page.locator('.app-settings').evaluate(node=>node.open))await page.getByRole('button',{name:'关闭设置',exact:true}).click();}
export async function backupLibrary(page){
 const wasOpen=await page.locator('.app-settings').evaluate(node=>node.open);
 await openSettings(page);
 try{const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'导出完整备份',exact:true}).click()]);return JSON.parse(await readFile(await download.path(),'utf8'));}
 finally{if(!wasOpen)await closeSettings(page);}
}
