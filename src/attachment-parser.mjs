import { inflateRawSync, crc32 } from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import sharp from 'sharp';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { AccessError } from './protocol.mjs';
import { MAX_ATTACHMENT_TEXT_BYTES } from './attachment-protocol.mjs';
export const PARSER_VERSION='collaboration-attachment-parser/1.0.1';
const hash=b=>createHash('sha256').update(b).digest('hex');
function checkedText(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{throw new AccessError(-32602,'Text is not valid UTF-8; encoding must be explicitly converted before upload');}}
function bounded(text){if(Buffer.byteLength(text)>MAX_ATTACHMENT_TEXT_BYTES)throw new AccessError(-32602,'Extracted text exceeds 256KiB; no silent truncation');return text;}
function zipDirectory(bytes){
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0)throw new AccessError(-32602,'Invalid DOCX ZIP directory');
 const count=bytes.readUInt16LE(end+10),directory=bytes.readUInt32LE(end+16);if(count<1||count>256)throw new AccessError(-32602,'DOCX ZIP entry limit');
 let offset=directory,total=0;const names=new Set(), entries=new Map();
 for(let i=0;i<count;i++){
  if(offset+46>bytes.length||bytes.readUInt32LE(offset)!==0x02014b50)throw new AccessError(-32602,'Malformed DOCX ZIP entry');
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),compressed=bytes.readUInt32LE(offset+20),size=bytes.readUInt32LE(offset+24),n=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32);
  if(flags&1||![0,8].includes(method)||size===0xffffffff||compressed===0xffffffff)throw new AccessError(-32602,'Encrypted/unsupported DOCX ZIP');
  if(offset+46+n+extra+comment>bytes.length)throw new AccessError(-32602,'Invalid DOCX ZIP entry length');
  const name=checkedText(bytes.subarray(offset+46,offset+46+n));
  const normalized=name.replaceAll('\\','/'),emptyDirectory=name.endsWith('/')&&size===0;
  if(normalized.startsWith('/')||normalized.includes(':')||normalized.split('/').includes('..')||names.has(name)||(name.includes('\\')&&!emptyDirectory))throw new AccessError(-32602,'Unsafe or duplicate DOCX ZIP name');
  // Some Word generators emit backslash-separated empty directory markers. They carry
  // no data, are never extracted or used as paths, and are harmless after traversal checks.
  entries.set(name,{size,compressed,method,crc:bytes.readUInt32LE(offset+16),localOffset:bytes.readUInt32LE(offset+42)});
  names.add(name);total+=size;if(size>8*1024*1024||total>16*1024*1024||(size>1024*1024&&size>Math.max(compressed,1)*200))throw new AccessError(-32602,'DOCX decompression limit');
  if(/vbaProject|embeddings\/|activeX\//i.test(name))throw new AccessError(-32602,'Active/macro/embedded-object DOCX is unsupported');
  offset+=46+n+extra+comment;
 }
 if(!names.has('word/document.xml')||!names.has('[Content_Types].xml'))throw new AccessError(-32602,'Not a valid Word DOCX package');
 return {names,entries};
}
function extractZipEntry(bytes,entry,name){
 const offset=entry.localOffset;
 if(offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50||bytes.readUInt16LE(offset+8)!==entry.method||(bytes.readUInt16LE(offset+6)&1))throw new AccessError(-32602,'Invalid DOCX local ZIP header');
 const n=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28),start=offset+30+n+extra;
 if(start+entry.compressed>bytes.length||checkedText(bytes.subarray(offset+30,offset+30+n))!==name)throw new AccessError(-32602,'DOCX ZIP local/central mismatch');
 const compressed=bytes.subarray(start,start+entry.compressed);
 const data=entry.method===0?compressed:inflateRawSync(compressed,{maxOutputLength:8*1024*1024});
 if(data.length!==entry.size||crc32(data)!==entry.crc)throw new AccessError(-32602,'DOCX ZIP entry integrity mismatch');
 return data;
}
function extractDocx(bytes){
 const {names,entries}=zipDirectory(bytes);
 const xml=checkedText(extractZipEntry(bytes,entries.get('word/document.xml'),'word/document.xml'));if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new AccessError(-32602,'XML entity declarations are forbidden');
 let depth=0,tags=0;for(const match of xml.matchAll(/<\/?[A-Za-z_][^>]*>/g)){if(++tags>150000)throw new AccessError(-32602,'DOCX XML element limit');if(match[0].startsWith('</'))depth--;else if(!match[0].endsWith('/>'))depth++;if(depth>80||depth<0)throw new AccessError(-32602,'DOCX XML nesting limit');}
 if(XMLValidator.validate(xml)!==true)throw new AccessError(-32602,'Invalid DOCX XML');
 const parser=new XMLParser({preserveOrder:true,ignoreAttributes:false,attributeNamePrefix:'@_',parseTagValue:false,processEntities:false,trimValues:false});
 const tree=parser.parse(xml),lines=[];let pictures=0,deleted=0;
 function visit(nodes){for(const node of nodes??[]){for(const[key,value]of Object.entries(node)){
  if(key===':@')continue;if(key==='w:del'){deleted++;continue;}
  if(key==='w:drawing'||key==='w:pict'){pictures++;continue;}
  if(key==='#text'){lines.push(String(value));continue;}
  if(key==='w:tab'){lines.push('\t');continue;}if(key==='w:br'){lines.push('\n');continue;}
  if(Array.isArray(value)){visit(value);if(key==='w:p')lines.push('\n');if(key==='w:tc')lines.push(' | ');if(key==='w:tr')lines.push('\n');}
 }}}
 visit(tree);
 const decode=s=>s.replace(/&#x([a-f\d]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi,(_m,h,d,e)=>h||d?String.fromCodePoint(Math.min(parseInt(h??d,h?16:10),0x10ffff)):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[e]);
 const text=bounded(decode(lines.join('')).replace(/\n{3,}/g,'\n\n').trim());
 const warnings=['Extracted body text only; no rendered pagination, headers/footers, comments, or external-link content fetched.'];
 if(pictures||[...names].some(n=>n.startsWith('word/media/')))warnings.push('Embedded images are not visually analyzed by this text extraction; brand/image evidence remains uncovered.');
 if(deleted||/<w:ins\b/.test(xml))warnings.push('Tracked revisions exist; inserted text included and deleted text omitted, not an approved final revision.');
 return {kind:'docx',content:text||null,warnings,embeddedImages:pictures,visualAnalysis:'not-performed'};
}
export async function parseAttachment(bytes,name){
 const extension=extname(name).toLowerCase();let parsed;
 if(['.txt','.md'].includes(extension))parsed={kind:extension.slice(1),content:bounded(checkedText(bytes)),warnings:[],visualAnalysis:'not-applicable'};
 else if(extension==='.docx')parsed=extractDocx(bytes);
 else if(['.png','.jpg','.jpeg','.webp','.gif'].includes(extension)){
  try{const image=sharp(bytes,{limitInputPixels:40*1024*1024,failOn:'warning',animated:true});const metadata=await image.metadata();
   const expected={'.png':'png','.jpg':'jpeg','.jpeg':'jpeg','.webp':'webp','.gif':'gif'}[extension];if(metadata.format!==expected||!metadata.width||!metadata.height||metadata.width>12000||metadata.height>12000||(metadata.pages??1)>100)throw new Error('Image limits/type mismatch');
   await sharp(bytes,{limitInputPixels:40*1024*1024,failOn:'warning',page:0,pages:1}).raw().toBuffer();
   parsed={kind:'image',content:null,format:metadata.format,width:metadata.width,height:metadata.pageHeight??metadata.height,pages:metadata.pages??1,visualAnalysis:'not-performed',warnings:['Image format/dimensions and first frame decoded; other animation frames/timing, visual content and OCR not analyzed. No vision tool is enabled in this release.']};
  }catch{throw new AccessError(-32602,'Invalid, unsupported, or over-limit image');}
 }else throw new AccessError(-32602,'Supported attachments: DOCX, UTF-8 MD/TXT, PNG/JPEG/WebP/GIF');
 return {...parsed,parserVersion:PARSER_VERSION,originalSha256:hash(bytes),textSha256:parsed.content===null?null:hash(Buffer.from(parsed.content))};
}
