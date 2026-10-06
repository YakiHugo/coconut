/** Small non-validating XML reader: no DTD, external/custom entities, scripts or I/O. */
const NAME = '[A-Za-z_][A-Za-z0-9_.:-]*';
export function decodeEntities(text) {
  return text.replace(/&([^;\s<&]+);/g,(match,name)=>{
    const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
    if (Object.hasOwn(named,name)) return named[name];
    if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(name)) throw new Error('XML 含不支持的实体');
    const number=name[1].toLowerCase()==='x' ? parseInt(name.slice(2),16) : Number(name.slice(1));
    if (number<1 || number>0x10ffff || (number>=0xd800 && number<=0xdfff)) throw new Error('XML 字符实体无效');
    return String.fromCodePoint(number);
  });
}
export function parseXml(input,baseUrl) {
  const text=String(input).replace(/^\uFEFF/,'');
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('不支持 XML DTD、实体声明或控制字符');
  const tokens=/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/(?:[^>]+)>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/gy;
  const root={children:[],ns:Object.assign(Object.create(null),{xml:'http://www.w3.org/XML/1998/namespace'}),nsCount:1,base:baseUrl,language:'',text:''},stack=[root];
  let index=0,nodes=0;
  while(index<text.length) {
    tokens.lastIndex=index;const match=tokens.exec(text);if(!match)throw new Error('XML 格式无效');
    const token=match[0];index=tokens.lastIndex;const parent=stack.at(-1);
    if(token.startsWith('<!--') || token.startsWith('<?'))continue;
    if(token.startsWith('<![CDATA[')){if(stack.length===1)throw new Error('XML 根元素无效');parent.text+=token.slice(9,-3);continue;}
    if(token.startsWith('</')){if(!/^<\/[A-Za-z_][A-Za-z0-9_.:-]*\s*>$/.test(token)||stack.length===1||token.slice(2,-1).trim()!==parent.name)throw new Error('XML 标签不匹配');stack.pop();continue;}
    if(token[0]!=='<'){if(stack.length===1&&token.trim())throw new Error('XML 根元素外含文字');parent.text+=decodeEntities(token);continue;}
    const opening=token.match(new RegExp('^<('+NAME+')([\\s\\S]*?)(/?)>$'));if(!opening)throw new Error('XML 标签无效');
    const [,name,attributeText,selfClosing]=opening,attrs=Object.create(null);
    const attr=new RegExp('\\s+('+NAME+')\\s*=\\s*(?:"([^"<]*)"|\'([^\'<]*)\')','gy');let position=0,attributeCount=0;
    while(position<attributeText.length){attr.lastIndex=position;const item=attr.exec(attributeText);if(!item){if(attributeText.slice(position).trim())throw new Error('XML 属性无效');break;}if(++attributeCount>64)throw new Error('XML 单节点属性过多');if(Object.hasOwn(attrs,item[1]))throw new Error('XML 属性重复');attrs[item[1]]=decodeEntities(item[2]??item[3]);position=attr.lastIndex;}
    // Structural sharing prevents namespace-count × node-count heap amplification.
    const ns=Object.create(parent.ns);let nsCount=parent.nsCount;
    for(const [key,value]of Object.entries(attrs)){
      const prefix=key==='xmlns'?'':key.startsWith('xmlns:')?key.slice(6):null;
      if(prefix===null)continue;
      if(!(prefix in ns)&&++nsCount>64)throw new Error('XML 命名空间过多');
      Object.defineProperty(ns,prefix,{value,enumerable:true,writable:false});
    }
    const parts=name.split(':');if(parts.length>2||(parts.length===2&&!ns[parts[0]]))throw new Error('XML 命名空间无效');
    let base=parent.base;try{if(attrs['xml:base'])base=new URL(attrs['xml:base'],base).href;}catch{throw new Error('XML 基础链接无效');}
    const node={name,local:parts.at(-1),uri:ns[parts.length===2?parts[0]:'']||'',attrs,ns,nsCount,base,language:attrs['xml:lang']||parent.language,children:[],text:''};
    if(++nodes>120000||stack.length>40)throw new Error('XML 节点数或嵌套过多');
    parent.children.push(node);if(!selfClosing)stack.push(node);
  }
  if(stack.length!==1||root.children.length!==1)throw new Error('XML 不完整或含多个根元素');
  return root.children[0];
}
