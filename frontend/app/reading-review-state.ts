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
