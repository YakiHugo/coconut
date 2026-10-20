/** Keep downloaded bytes, filenames and executor MIME identity consistent. */
const formats: Record<string,{extension:string;type:string;kind:'audio'|'video'}> = {
 'audio/mpeg':{extension:'mp3',type:'audio/mpeg',kind:'audio'},
 'audio/mp3':{extension:'mp3',type:'audio/mpeg',kind:'audio'},
 'audio/mp4':{extension:'m4a',type:'audio/mp4',kind:'audio'},
 'audio/x-m4a':{extension:'m4a',type:'audio/mp4',kind:'audio'},
 'audio/wav':{extension:'wav',type:'audio/wav',kind:'audio'},
 'audio/wave':{extension:'wav',type:'audio/wav',kind:'audio'},
 'audio/x-wav':{extension:'wav',type:'audio/wav',kind:'audio'},
 'audio/ogg':{extension:'ogg',type:'audio/ogg',kind:'audio'},
 'audio/flac':{extension:'flac',type:'audio/flac',kind:'audio'},
 'audio/x-flac':{extension:'flac',type:'audio/flac',kind:'audio'},
 'audio/aac':{extension:'aac',type:'audio/aac',kind:'audio'},
 'audio/webm':{extension:'weba',type:'audio/webm',kind:'audio'},
 'video/mp4':{extension:'mp4',type:'video/mp4',kind:'video'},
 'video/webm':{extension:'webm',type:'video/webm',kind:'video'},
 'video/ogg':{extension:'ogv',type:'video/ogg',kind:'video'},
 'video/quicktime':{extension:'mov',type:'video/quicktime',kind:'video'},
};
function mediaFormat(contentType:string){
 const type=contentType.split(';')[0].trim().toLowerCase();
 return Object.hasOwn(formats,type)?formats[type]:null;
}
export function downloadedMediaFile(parts:BlobPart[],{name,contentType,kind}:{name?:string;contentType:string;kind:'audio'|'video'}):File{
 const format=mediaFormat(contentType);
 if(!format||format.kind!==kind)throw Error('原声响应类型与所选来源不一致，未打开或发送识别。');
 // This is only an executor filename; never mutate the saved episode title.
 // Limit UTF-8 bytes as well as JS length, without splitting surrogate pairs.
 const clean=(name||'原声').normalize('NFC').replace(/[\\/\u0000-\u001f\u007f<>:"|?*]/g,'_').trim().replace(/[. ]+$/g,'')||'原声';
 let stem='';const encode=new TextEncoder();
 for(const char of clean){if(encode.encode(stem+char).length>180)break;stem+=char;}
 return new File(parts,'coconut-'+stem+'.'+format.extension,{type:format.type,lastModified:0});
}
const executorTypes:Record<string,string>={mp3:'audio/mpeg',m4a:'audio/mp4',wav:'audio/wav',ogg:'audio/ogg',flac:'audio/flac',mp4:'video/mp4',webm:'video/webm'};
/** Refuse deterministically invalid uploads before writing a durable operation. */
export function transcriptionFileIssue(file:Pick<File,'name'|'type'|'size'|'lastModified'>):string|null{
 if(!file.name||file.name.length>300||/[\\/\u0000-\u001f\u007f]/.test(file.name))return '文件名称不符合本地识别协议，请使用不含斜线或控制字符的简短名称。';
 if(!Number.isSafeInteger(file.size)||file.size<1||file.size>200*1024*1024||!Number.isSafeInteger(file.lastModified)||file.lastModified<0)return '生成文字稿支持不超过 200 MiB 的原音视频文件。';
 const extension=file.name.split('.').at(-1)?.toLowerCase()||'',expected=Object.hasOwn(executorTypes,extension)?executorTypes[extension]:null;
 if(!expected)return '此媒体可继续回听，但当前本地识别协议不支持此容器；请提供 MP3、M4A、WAV、OGG、FLAC、MP4 或视频 WebM 文件。';
 const type=file.type.split(';')[0].trim().toLowerCase();
 if(type&&type!=='application/octet-stream'&&mediaFormat(type)?.type!==expected)return '媒体类型与文件扩展名不一致，未发送识别；请提供格式匹配的原文件。';
 return null;
}
