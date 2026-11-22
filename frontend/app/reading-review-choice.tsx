import {useEffect,useState} from 'react';
import {REVIEW_PROVIDERS} from '@coconut/shared/transcript-review';

const labels:Record<string,string>={codex:'Codex CLI',kimi:'Kimi CLI',claude:'Claude Code'};
export type ReviewChoice={provider:string;checked:boolean;setChecked:(value:boolean)=>void};

export function useReadingReviewChoice(enabled:boolean):ReviewChoice {
    const capabilities=(window as any).CoconutClientCapabilities;
    const [connection,setConnection]=useState(()=>capabilities?.generation);
    const [provider,setProvider]=useState(''),[checked,setChecked]=useState(false);
    useEffect(()=>{
        const changed=()=>{setProvider('');setChecked(false);setConnection(capabilities?.generation);};
        window.addEventListener('coconut-client-changed',changed);
        return()=>window.removeEventListener('coconut-client-changed',changed);
    },[capabilities]);
    enabled=enabled&&capabilities?.allows('transcriptReview')===true;
    useEffect(()=>{
        if(!enabled){setProvider('');setChecked(false);return;}
        const owner=new AbortController();
        fetch('/api/v1/transcript-review/capabilities?readiness=1',{signal:owner.signal})
            .then(response=>response.ok?response.json():null)
            .then(value=>{
                if(owner.signal.aborted||!value?.reading||value.status?.ready!==true||!REVIEW_PROVIDERS.includes(value.defaultProvider))return;
                setProvider(value.defaultProvider);
                try{setChecked(localStorage.getItem('coconut-auto-reading-review-v1')===value.defaultProvider);}catch{}
            }).catch(()=>{});
        return()=>owner.abort();
    },[enabled,connection]);
    return {provider:enabled?provider:'',checked:enabled&&!!provider&&checked,setChecked(value){
        setChecked(value);
        try{localStorage.setItem('coconut-auto-reading-review-v1',value?provider:'');}catch{}
    }};
}

export function ReadingReviewChoice({value,when,disabled}:{value:ReviewChoice;when:string;disabled?:boolean}) {
    return value.provider?<label><input type="checkbox" checked={value.checked} disabled={disabled}
        onChange={event=>value.setChecked(event.target.checked)}/>{when}用 {labels[value.provider]} 精校（发送文字稿和节目资料）</label>:null;
}
