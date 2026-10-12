/** Native-suite event checkpoints. Property changes alone are not event receipts. */
export function mediaStarted(actual,before,{seek=false}={}){
 return !actual.paused&&!actual.seeking&&actual.receipts.play>before.play&&actual.receipts.playing>before.playing&&(!seek||actual.receipts.seeked>before.seeked);
}
export function mediaPaused(actual,before){
 return actual.paused&&(actual.receipts.pause||0)>=(before.receipts.pause||0)+(before.paused?0:1);
}
