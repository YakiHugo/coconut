import {REVIEW_PROVIDERS,signature} from '@coconut/shared/transcript-review';
import type {AppStore} from './store';
import type {Document} from './contracts';

const pendingKey=(key:string)=>'coconut-reading-review:'+key;

export function pendingReadingReview(key:string):boolean {
    try{return sessionStorage.getItem(pendingKey(key))==='pending';}catch{return false;}
}

export function rememberReadingReview(key:string,pending:boolean) {
    try{
        if(pending)sessionStorage.setItem(pendingKey(key),'pending');
        else sessionStorage.removeItem(pendingKey(key));
    }catch{}
}

export function readingReviewSubmissionFailure(key:string) {
    try{return sessionStorage.getItem('coconut-reading-review-error:'+key)||'';}catch{return '';}
}

export function reportReadingReviewSubmission(key:string,message:string) {
    try{
        if(message)sessionStorage.setItem('coconut-reading-review-error:'+key,message.slice(0,300));
        else sessionStorage.removeItem('coconut-reading-review-error:'+key);
    }catch{}
    window.dispatchEvent(new CustomEvent('coconut-reading-review-started',{detail:key}));
}

export async function queueReadingReview(store:AppStore,document:Document,provider:string,id:string=crypto.randomUUID()) {
    if(!REVIEW_PROVIDERS.includes(provider)||!document.segments.length)return;
    const expected=signature(document);
    try{
        const flushed=await store.flush(),current=store.getDocument(document.key);
        if(!flushed.ok||!current||signature(current)!==expected)
            throw Error('原稿尚未保存或已更新，请从阅读页发起精校。');
        const response=await fetch('/api/v1/transcript-review/jobs',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({protocolVersion:1,operation_id:id,key:document.key,consent:true,kind:'reading',provider,source_signature:expected})});
        const result=await response.json();
        if(!response.ok)throw Error(typeof result.error==='string'?result.error:'精校未提交');
        rememberReadingReview(document.key,true);
        reportReadingReviewSubmission(document.key,'');
    }catch(error){
        reportReadingReviewSubmission(document.key,error instanceof Error?error.message:'精校未提交。');
    }
}
