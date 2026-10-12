import test from 'node:test';
import assert from 'node:assert/strict';
import {focusRingPoints,evaluateFocusRingPixels} from './helpers/focus-ring-pixels.mjs';
test('ring probes sample all four painted stroke centers outside the control, away from rounded corners',()=>{
 const r={left:70,top:126,right:114,bottom:170,width:44,height:44},points=focusRingPoints(r,3,3);assert.equal(points.length,12);
 for(const side of ['top','bottom','left','right'])assert.equal(points.filter(p=>p.side===side).length,3);
 for(const p of points){assert.ok(p.x<r.left||p.x>r.right||p.y<r.top||p.y>r.bottom);if(p.side==='bottom')assert.equal(p.y,174.5);if(p.side==='top')assert.equal(p.y,121.5);if(p.side==='left')assert.equal(p.x,65.5);if(p.side==='right')assert.equal(p.x,118.5);}
});
test('outline stroke width and offset both contribute without changing the existing geometry thresholds',()=>{
 const r={left:20,top:20,right:120,bottom:64,width:100,height:44};assert.equal(focusRingPoints(r,4,2)[0].y,16);assert.equal(focusRingPoints(r,2,0)[0].y,19);
});

test('pixel proof rejects the old canvas-covered bottom edge and even one missing stroke sample',()=>{
 const expected=[219,116,82,255],points=focusRingPoints({left:70,top:126,right:114,bottom:170,width:44,height:44},3,3).map(point=>({...point,rgba:[...expected]}));
 assert.ok(evaluateFocusRingPixels({expected,points}).points.every(p=>p.matches));
 const covered=points.map(p=>({...p,rgba:p.side==='bottom'?[250,249,247,255]:p.rgba}));assert.equal(evaluateFocusRingPixels({expected,points:covered}).points.filter(p=>!p.matches).length,3);
 const missing=points.map((p,i)=>({...p,rgba:i===0?[250,249,247,255]:p.rgba}));assert.equal(evaluateFocusRingPixels({expected,points:missing}).points.every(p=>p.matches),false);
 for(const rgba of [[],[219,116,82,0],[219,116,82,250],[0,0,0,255]])assert.equal(evaluateFocusRingPixels({expected,points:[{rgba}]}).points[0].matches,false);
});
