import {useEffect,useState} from 'react';
import {createNativeMediaController} from '../native-media/controller';
import {NativeMediaPanel} from '../native-media/panel';
import type {AppStore} from './store';
export function NativeMedia({store,documentKey}:{store:AppStore;documentKey:string|null}){
 const [controller]=useState(()=>{const bridge=(window as any).coconutLocalMedia;return bridge?createNativeMediaController({bridge,owner:store.nativeOwner,active:key=>store.getSnapshot().workspace==='read'&&store.getSnapshot().activeKey===key,media:store.getMedia,file:store.getFile,attach:store.setMedia}):null;});
 useEffect(()=>{if(!controller)return;store.setNativeLifecycle(controller);const owners=store.completeNativeOwners();if(owners)void controller.initialize(owners);const closed=()=>{controller.dispose();store.releaseNativeMedia();};window.addEventListener('pagehide',closed);return()=>{window.removeEventListener('pagehide',closed);store.setNativeLifecycle(null);controller.dispose();};},[controller,store]);
 if(!controller)return null;const pending=store.pendingRetirements();if(pending.length)return <section><p>旧原文件引用尚未确认取消。新的记住操作暂停，原文件不会删除。</p>{pending.map(item=><button key={item.key} disabled={item.pending} onClick={()=>void store.retryRetirement(item.key)}>重试取消旧引用</button>)}</section>;if(!documentKey||!store.getDocument(documentKey)?.local_media_source)return null;
 return <NativeMediaPanel controller={controller} documentKey={documentKey} canRemember={!!store.getFile(documentKey)&&!!store.nativeOwner(documentKey)} hasMedia={!!store.getMedia(documentKey)} onRelink={()=>{store.invalidateMedia();store.navigate('discover');store.setMessage('打开原音视频文件后，核对候选项目并明确关联。');}}/>;
}
