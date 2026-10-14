/** Only authored fixture content, never a real model or user document. */
export async function selectionActionsBrowser(page,{check,capture}){
 const source={title:'选择原话 · Authored reading fixture',language:'en',segments:[
  {id:'selection-a',start:0,end:5,text:'The station plan looked faster, but we had left out the time people needed to cross the road safely.',speaker:'Mina'},
  {id:'selection-b',start:5,end:10,text:'Our first estimate changed after we watched the crossing.',speaker:'Mina'}]};
 await page.locator('#file').setInputFiles({name:'selection.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(source))});
 await page.locator('#mode-passages').click();
 await page.waitForFunction(()=>document.body.dataset.transcriptNavigation==='ready'&&!!window.CoconutSelectionActions);
 const choose=async()=>{
  await page.locator('.passage-original').first().scrollIntoViewIfNeeded();
  await page.locator('.passage-original').first().evaluate(p=>{
   const text=p.querySelector('.passage-cue').firstChild,range=document.createRange();range.setStart(text,4);range.setEnd(text,16);
   const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));
  });
  await page.locator('.selection-actions').waitFor({state:'visible'});
 };
 for(const width of [1360,390,320]){
  await page.setViewportSize({width,height:900});await choose();
  check(`selection_${width}_toolbar_fits`,await page.locator('.selection-actions').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
  await capture(page,`selection-${width}-actions`,false);
  await page.locator('.selection-actions').getByRole('button',{name:'翻译所选',exact:true}).click();
  await page.locator('#passage-question-dialog').waitFor({state:'visible'});
  check(`selection_${width}_exact_target`,await page.locator('#passage-selection-text').textContent()==='station plan');
  check(`selection_${width}_explicit_context`,(await page.locator('#passage-question-state').textContent()).includes('完整原片段作为上下文'));
  check(`selection_${width}_no_implicit_consent`,!await page.locator('#ai-consent').isChecked());
  check(`selection_${width}_one_composer`,await page.locator('#ai-request-panel').count()===1);
  await capture(page,`selection-${width}-translation-review`,false);
  await page.locator('#close-passage-question').click();await choose();
  await page.keyboard.press('Escape');check(`selection_${width}_escape_dismisses`,await page.locator('.selection-actions').count()===0);
  // Native keyboard fallback owns the exact same source-selection controller.
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.locator('.passage-quote').first().click();
  await page.locator('#quotation-source').evaluate(n=>{n.focus();n.setSelectionRange(4,16);});
  await page.locator('#quotation-preview-selection').click();
  await page.locator('#quotation-context-actions').getByRole('button',{name:'解释所选',exact:true}).click();
  check(`selection_${width}_keyboard_fallback`,await page.locator('#passage-selection-text').textContent()==='station plan');
  await page.locator('#close-passage-question').click();
  check(`selection_${width}_restores_source_focus`,await page.locator('.passage-quote').first().evaluate(n=>n===document.activeElement));
 }
 // Native Chromium normalizes textarea CRLF. Assert the actual request and
 // reloaded saved history, rather than relying on DOM-emulator string behavior.
 const raw='alpha\r\nbeta  ',requests=[];
 const healthRoute=route=>route.fulfill({json:{local_worker:false,capabilities:{local_agents:true}}});
 const toolRoute=route=>route.fulfill({json:{ai:{codex:{ready:true},claude:{ready:true}}}});
 const answerRoute=async route=>{requests.push(route.request().postDataJSON());await route.fulfill({json:{answer:'Authored CRLF response.',citations:['crlf-a'],provider:'synthetic-test-fixture'}});};
 // Retire the authored prior draft via its UI before changing test service mode.
 await page.locator('#dismiss-passage-question-return').click();
 await page.route('**/api/health',healthRoute);await page.route('**/api/language-tools',toolRoute);await page.route('**/api/ask',answerRoute);
 try{
  // Exercise the real capability handshake; never force-enable a disabled UI.
  await page.reload();await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready'&&!document.getElementById('check-ai').disabled);
  check('selection_injected_service_capability_ready',(await page.locator('#worker-status').textContent()).includes('轻量本地服务已连接'));
  await page.locator('#file').setInputFiles({name:'crlf-selection.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({title:'Authored exact CRLF selection',segments:[{id:'crlf-a',start:0,end:5,text:raw}]}))});
  await page.locator('#mode-passages').click();await page.locator('.passage-original').first().scrollIntoViewIfNeeded();
  await page.locator('.passage-original').first().evaluate(p=>{const text=p.querySelector('.passage-cue').firstChild,r=document.createRange();r.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));});
  await page.locator('.selection-actions').getByRole('button',{name:'解释所选',exact:true}).click();
  check('selection_crlf_readonly_target_exact',await page.locator('#passage-selection-text').textContent()===raw);
  check('selection_instruction_has_no_encoded_target',!(await page.locator('#ai-question').inputValue()).includes('alpha'));
  await page.locator('#check-ai').click();await page.locator('#ai-consent').check();await capture(page,'selection-native-crlf-consent',false);await page.locator('#ask-ai').click();
  await page.waitForFunction(()=>document.getElementById('ai-progress').textContent.includes('回答已保存在'));
  check('selection_crlf_request_exact',requests.length===1&&requests[0].question.includes('所选原文：\n'+raw+'\n【所选原文结束】'));
  await page.locator('#close-passage-question').click();await page.locator('#return-passage-question').click();
  check('selection_crlf_return_preserves_target',await page.locator('#passage-selection-text').textContent()===raw&&!await page.locator('#ai-consent').isChecked());
  await capture(page,'selection-native-crlf-review',false);await page.locator('#close-passage-question').click();
  await page.reload();await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');await page.locator('#mode-passages').click();await page.locator('.passage-ask').first().click();
  check('selection_crlf_reloaded_history_exact',(await page.locator('#ai-answers .ai-answer > strong').first().textContent()).includes('所选原文：\n'+raw+'\n【所选原文结束】'));
  await page.locator('#close-passage-question').click();
 }finally{await page.unroute('**/api/health',healthRoute);await page.unroute('**/api/language-tools',toolRoute);await page.unroute('**/api/ask',answerRoute);}
 // Subsequent standalone-Web checks must see the original static-only server.
 await page.reload();await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready'&&document.getElementById('check-ai').disabled&&document.getElementById('worker-status').textContent.includes('未连接本地服务'));
 check('selection_service_fixture_restores_static_web',(await page.locator('#worker-status').textContent()).includes('未连接本地服务'));
 await page.setViewportSize({width:1360,height:1000});
}
