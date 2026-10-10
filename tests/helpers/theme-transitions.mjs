// Serializable browser predicate: never disable animation or alter the theme.
export function themeTransitionsSettled(selectors) {
 for (const selector of selectors) {
  for (let node=document.querySelector(selector); node; node=node.parentElement) {
   // Flush the new theme's style before discovering its CSS transitions.
   getComputedStyle(node).backgroundColor;
   if (node.getAnimations().some(animation=>animation instanceof CSSTransition &&
       (animation.pending || animation.playState==='running'))) return false;
  }
 }
 return true;
}
