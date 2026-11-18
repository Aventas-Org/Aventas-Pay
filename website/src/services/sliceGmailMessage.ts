/** Parse Gmail API messages as data; never execute HTML. */
function normalizedSubject(subject:string):string {
  return subject.replace(/=\?utf-8\?([bq])\?([^?]+)\?=/gi,(orig:string,kind:string,txt:string)=>{
    try {
      if(String(kind).toLowerCase()==="b")return Buffer.from(txt,"base64").toString("utf8");
      return Buffer.from(txt.replace(/_/g," ").replace(/=([0-9a-f]{2})/gi,(_:string,hex:string)=>String.fromCharCode(parseInt(hex,16))),"binary").toString("utf8");
    }catch{return orig;}
  });
}
function htmlAsText(html:string):string|null {
  if(html.length>60_000)return null;
  const text=html
    .replace(/<!--[\s\S]*?-->/g," ")
    .replace(/<(script|style|head|svg|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi," ")
    .replace(/<br\b[^>]*\/?>/gi,"\n")
    .replace(/<\/?(?:p|div|tr|li|section|article|table|h[1-6])\b[^>]*>/gi,"\n")
    .replace(/<\/?(?:td|th)\b[^>]*>/gi," ")
    .replace(/<[^>]*>/g," ")
    .replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos|rsquo|ndash|mdash);/gi,(_,entity:string)=>{
      const x=entity.toLowerCase();
      const named:Record<string,string>={nbsp:" ",amp:"&",lt:"<",gt:">",quot:'"',apos:"'",rsquo:"’",ndash:"-",mdash:"—"};
      if(x in named)return named[x]!;
      const cp=x.startsWith("#x")?parseInt(x.slice(2),16):parseInt(x.slice(1),10);
      return Number.isInteger(cp)&&cp>0&&cp<=0x10ffff&&!(cp>=0xd800&&cp<=0xdfff)?String.fromCodePoint(cp):" ";
    })
    .replace(/\u00a0/g," ").replace(/[ \t]+\n/g,"\n").replace(/\n[ \t]+/g,"\n")
    .replace(/\n{3,}/g,"\n\n").trim();
  return text.length>0 && text.length<=12_000?text:null;
}
function decodedPart(part:Record<string,unknown>):string|null {
  const b=part.body&&typeof part.body==="object"?(part.body as Record<string,unknown>).data:undefined;
  if(typeof b!=="string"||b.length===0||b.length>80_000||!/^[A-Za-z0-9_-]+={0,2}$/.test(b))return null;
  try {
    const raw=Buffer.from(b,"base64url").toString("utf8");
    if(part.mimeType==="text/plain")return raw.length<=12_000?raw:null;
    if(part.mimeType==="text/html")return htmlAsText(raw);
  }catch{return null;}
  return null;
}
function payloadBody(payload:unknown,format:"text/plain"|"text/html",depth=0):string|null {
  if(!payload||typeof payload!=="object"||depth>5)return null;
  const p=payload as Record<string,unknown>;
  if(p.mimeType===format){const decoded=decodedPart(p);if(decoded)return decoded;}
  if(Array.isArray(p.parts)&&p.parts.length<=30){
    for(const part of p.parts){const text=payloadBody(part,format,depth+1);if(text)return text;}
  }
  return null;
}
function header(payload:unknown,name:string):string {
  const p=payload as {headers?:{name?:string;value?:string}[]}|null;
  const h=p?.headers?.find(x=>x.name?.toLowerCase()===name.toLowerCase());
  return typeof h?.value==="string"?h.value:"";
}
export function parseGmailMessage(msg:unknown):Record<string,unknown>|null {
  if(!msg||typeof msg!=="object")return null;
  const m=msg as Record<string,unknown>;
  if(typeof m.id!=="string"||!/^[a-f0-9]{12,32}$/.test(m.id)||typeof m.internalDate!=="string"||! /^\d{13}$/.test(m.internalDate))return null;
  const body=payloadBody(m.payload,"text/plain")??payloadBody(m.payload,"text/html");
  if(!body)return null;
  return {gmail_message_id:m.id,internal_date_ms:Number(m.internalDate),
    from:header(m.payload,"from"),authentication_results:header(m.payload,"authentication-results"),
    subject:normalizedSubject(header(m.payload,"subject")),body};
}
