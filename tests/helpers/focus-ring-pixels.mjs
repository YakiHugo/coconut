/** Sample the painted stroke, not the control's hit box or its ancestor clips. */
export function focusRingPoints(r,outlineWidth,outlineOffset){
 const distance=Math.max(0,outlineOffset)+outlineWidth/2;
 return [0.25,0.5,0.75].flatMap(t=>[
  {side:'top',x:r.left+r.width*t,y:r.top-distance},
  {side:'bottom',x:r.left+r.width*t,y:r.bottom+distance},
  {side:'left',x:r.left-distance,y:r.top+r.height*t},
  {side:'right',x:r.right+distance,y:r.top+r.height*t}
 ]);
}
export function evaluateFocusRingPixels(proof){
 return {...proof,points:proof.points.map(point=>({...point,matches:point.rgba.length===4&&point.rgba[3]===proof.expected[3]&&point.rgba.slice(0,3).every((value,index)=>Math.abs(value-proof.expected[index])<=16)}))};
}
export async function paintedFocusRing(page,png,proof){
 const points=focusRingPoints(proof.r,proof.outlineWidth,proof.outlineOffset);
 const proofPixels=await page.evaluate(async({data,points,color,width,height})=>{
  const image=new Image();image.src=data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);
  const swatch=document.createElement('canvas');swatch.width=swatch.height=1;const paint=swatch.getContext('2d');paint.fillStyle=color;paint.fillRect(0,0,1,1);const expected=[...paint.getImageData(0,0,1,1).data];
  return {expected,imageWidth:image.width,imageHeight:image.height,points:points.map(point=>{const x=Math.floor(point.x*image.width/width),y=Math.floor(point.y*image.height/height),inside=x>=0&&y>=0&&x<image.width&&y<image.height,rgba=inside?[...context.getImageData(x,y,1,1).data]:[];return {...point,pixelX:x,pixelY:y,rgba};})};
 },{data:'data:image/png;base64,'+png.toString('base64'),points,color:proof.outlineColor,width:proof.width,height:proof.height});
 return evaluateFocusRingPixels(proofPixels);
}
