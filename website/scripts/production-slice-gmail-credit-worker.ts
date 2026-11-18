/**
 * Isolated Railway production Slice credit-email scanner. Uses the existing
 * gmail.readonly OAuth grant, and only speaks to pay.aventasgaming.com with a
 * dedicated secret. No public listener, no raw mail body/secrets in logs.
 *
 * This is a merchant-authorized EMAIL approval policy; it does not certify
 * that bank funds settled. Immutable D1 approval + bot CAS gate fulfillment.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ORIGIN = "https://pay.aventasgaming.com";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const POLL_MS = 5_000;
const PATH = "/data/aventas-slice-credit-production.sqlite3";
type Fetcher = typeof fetch;
type Env = Readonly<Record<string,string|undefined>>;

export function validProductionEnv(env:Env):boolean {
  return env.APP_ENV==="production" &&
    env.SLICE_EMAIL_APPROVAL_MODE==="oauth" &&
    env.SLICE_EMAIL_INGEST_ENABLED==="true" &&
    env.PRODUCTION_SLICE_EMAIL_ORIGIN===ORIGIN &&
    env.RAILWAY_VOLUME_MOUNT_PATH==="/data" &&
    !!env.GMAIL_OAUTH_CLIENT_ID && env.GMAIL_OAUTH_CLIENT_ID.length>=10 &&
    !!env.GMAIL_OAUTH_CLIENT_SECRET && env.GMAIL_OAUTH_CLIENT_SECRET.length>=10 &&
    !!env.GMAIL_OAUTH_REFRESH_TOKEN && env.GMAIL_OAUTH_REFRESH_TOKEN.length>=10 &&
    !!env.SLICE_EMAIL_INGEST_SECRET && env.SLICE_EMAIL_INGEST_SECRET.length>=40;
}
function parseBody(body:unknown):Record<string,unknown> {
  if (!body || typeof body!=="object" || Array.isArray(body)) throw Error("BAD_RESPONSE");
  return body as Record<string,unknown>;
}
async function fetchJson(fetcher:Fetcher,url:string,init:RequestInit):Promise<Record<string,unknown>> {
  let response:Response;
  try {response=await fetcher(url,{...init,redirect:"error",cache:"no-store",
    signal:AbortSignal.timeout(10_000)});}
  catch {throw Error("UPSTREAM_UNAVAILABLE");}
  if(!response.ok) throw Error("UPSTREAM_UNAVAILABLE");
  try{return parseBody(await response.json());}catch{throw Error("UPSTREAM_INVALID");}
}
function normalizedSubject(subject:string):string {
  // Slice uses UTF-8 Q-encoding for INR symbol in some Gmail API payloads.
  return subject.replace(/=\?utf-8\?([bq])\?([^?]+)\?=/gi, (orig,kind,txt)=>{
    try {
      if (String(kind).toLowerCase()==="b") return Buffer.from(txt,"base64").toString("utf8");
      return Buffer.from(txt.replace(/_/g," ").replace(/=([0-9a-f]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))),"binary").toString("utf8");
    } catch {return orig;}
  });
}
function payloadBody(payload:unknown,depth=0):string|null {
  if (!payload || typeof payload!=="object" || depth>5) return null;
  const p=payload as Record<string,unknown>;
  if(p.mimeType==="text/plain" && p.body && typeof p.body==="object"){
    const b=(p.body as Record<string,unknown>).data;
    if(typeof b==="string" && b.length<=30_000) {
      try{return Buffer.from(b,"base64url").toString("utf8");}catch{return null;}
    }
  }
  if(Array.isArray(p.parts)){
    for(const part of p.parts){
      const t=payloadBody(part,depth+1);
      if(t) return t;
    }
  }
  return null;
}
function header(payload:unknown,name:string):string {
  const p=payload as {headers?:{name?:string;value?:string}[]}|null;
  const h=p?.headers?.find(x=>x.name?.toLowerCase()===name.toLowerCase());
  return typeof h?.value==="string"?h.value:"";
}
export function parseGmailMessage(msg:unknown):Record<string,unknown>|null {
  if (!msg || typeof msg!=="object") return null;
  const m=msg as Record<string,unknown>;
  if(typeof m.id!=="string"||!/^[a-f0-9]{12,32}$/.test(m.id)||
     typeof m.internalDate!=="string"|| !/^\d{13}$/.test(m.internalDate))return null;
  const body=payloadBody(m.payload);
  if(!body) return null;
  const subject=normalizedSubject(header(m.payload,"subject"));
  return {
    gmail_message_id:m.id,
    internal_date_ms:Number(m.internalDate),
    from:header(m.payload,"from"),
    authentication_results:header(m.payload,"authentication-results"),
    subject,body,
  };
}

export interface SeenStore {
  seen(id:string):boolean;
  mark(id:string,state:string):void;
}
export function sqliteSeenDb(path=PATH):{database:Database;store:SeenStore}{
  if(!path.startsWith("/data/")&&!path.startsWith("/tmp/"))throw Error("BAD_VOLUME");
  mkdirSync(dirname(path),{recursive:true});
  const database=new Database(path,{create:true});
  database.run("PRAGMA journal_mode=WAL");
  database.run(`CREATE TABLE IF NOT EXISTS processed_messages
   (gmail_id TEXT PRIMARY KEY,decision TEXT NOT NULL,processed_at INTEGER NOT NULL)`);
  return {database,store:{
    seen:(id)=>!!database.prepare("SELECT 1 FROM processed_messages WHERE gmail_id=?").get(id),
    mark:(id,state)=>{
      database.prepare("INSERT OR IGNORE INTO processed_messages VALUES(?,?,?)")
        .run(id,state,Date.now());
    },
  }};
}
export class OAuthCache {
  private access="";
  private until=0;
  async token(env:Env,fetcher:Fetcher,now=Date.now()):Promise<string>{
    if(this.access && now<this.until) return this.access;
    const body=new URLSearchParams({
      client_id:env.GMAIL_OAUTH_CLIENT_ID!,
      client_secret:env.GMAIL_OAUTH_CLIENT_SECRET!,
      refresh_token:env.GMAIL_OAUTH_REFRESH_TOKEN!,
      grant_type:"refresh_token",
    });
    // OAuth token errors are deliberately classified using Google error
    // *codes*, never raw response bodies, error descriptions or credentials.
    let response:Response;
    try {
      response=await fetcher(TOKEN_URL,{
        method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
        body,redirect:"error",cache:"no-store",signal:AbortSignal.timeout(10_000),
      });
    } catch {
      throw Error("OAUTH_TRANSPORT_ERROR");
    }
    let raw:unknown;
    try { raw=await response.json(); } catch {
      throw Error("OAUTH_NONJSON_RESPONSE");
    }
    const result=parseBody(raw);
    if (!response.ok) {
      const error=typeof result.error==="string" ? result.error : "";
      // Only approved constant error codes are emitted to Railway.
      if(error==="invalid_grant") throw Error("OAUTH_INVALID_GRANT");
      if(error==="invalid_client") throw Error("OAUTH_INVALID_CLIENT");
      if(error==="unauthorized_client") throw Error("OAUTH_UNAUTHORIZED_CLIENT");
      if(error==="access_denied") throw Error("OAUTH_ACCESS_DENIED");
      if(error==="invalid_scope") throw Error("OAUTH_INVALID_SCOPE");
      if(error==="temporarily_unavailable" || response.status>=500)
        throw Error("OAUTH_PROVIDER_UNAVAILABLE");
      throw Error("OAUTH_TOKEN_REJECTED");
    }
    // Google can return additional scopes on an otherwise valid grant.
    // Check membership rather than rejecting an entire space-delimited list.
    const scopes=typeof result.scope==="string"
      ? result.scope.trim().split(/\s+/) : null;
    if(typeof result.token_type!=="string" ||
       result.token_type.toLowerCase()!=="bearer" ||
       typeof result.access_token!=="string" ||
       result.access_token.length<10 ||
       typeof result.expires_in!=="number" ||
       !Number.isFinite(result.expires_in) ||
       result.expires_in<60 || result.expires_in>7200) {
      throw Error("OAUTH_INVALID_TOKEN_RESPONSE");
    }
    if(scopes && !scopes.includes("https://www.googleapis.com/auth/gmail.readonly"))
      throw Error("OAUTH_SCOPE_MISMATCH");
    this.access=result.access_token;
    this.until=now+(result.expires_in-60)*1000;
    return this.access;
  }
}
export async function scanOnce(env:Env,store:SeenStore,cache:OAuthCache,
  fetcher:Fetcher=fetch):Promise<{eligible:number;examined:number;approved:number;review:number}> {
  if(!validProductionEnv(env))throw Error("PRODUCTION_EMAIL_DISABLED");
  const headers={authorization:"Bearer "+env.SLICE_EMAIL_INGEST_SECRET,accept:"application/json"};
  const snapshot=await fetchJson(fetcher,ORIGIN+"/api/internal/slice-email/sessions",{
    method:"GET",headers,
  }).catch(()=>{throw Error("SLICE_SNAPSHOT_UNAVAILABLE");});
  if(!Array.isArray(snapshot.eligible)||snapshot.eligible.length>100)throw Error("INVALID_SNAPSHOT");
  if(snapshot.eligible.length===0)return {eligible:0,examined:0,approved:0,review:0};

  const accessToken=await cache.token(env,fetcher).catch(error=>{
    const safe=new Set([
      "OAUTH_TRANSPORT_ERROR","OAUTH_NONJSON_RESPONSE","OAUTH_INVALID_GRANT",
      "OAUTH_INVALID_CLIENT","OAUTH_UNAUTHORIZED_CLIENT","OAUTH_ACCESS_DENIED",
      "OAUTH_INVALID_SCOPE","OAUTH_PROVIDER_UNAVAILABLE","OAUTH_TOKEN_REJECTED",
      "OAUTH_INVALID_TOKEN_RESPONSE","OAUTH_SCOPE_MISMATCH",
    ]);
    if(error instanceof Error && safe.has(error.message)) throw error;
    throw Error("SLICE_GMAIL_OAUTH_UNAVAILABLE");
  });
  const list=await fetchJson(fetcher,GMAIL+"?"+new URLSearchParams({
    q:"from:noreply@slice.bank.in subject:Received newer_than:2d",
    maxResults:"30",
  }),{method:"GET",headers:{authorization:"Bearer "+accessToken}})
    .catch(()=>{throw Error("SLICE_GMAIL_LIST_UNAVAILABLE");});
  if(list.messages!==undefined && (!Array.isArray(list.messages)||list.messages.length>30))
    throw Error("INVALID_GMAIL_LIST");
  let examined=0,approved=0,review=0;
  for(const entry of (list.messages??[]) as Record<string,unknown>[]){
    if(!entry||typeof entry.id!=="string"||!/^[a-f0-9]{12,32}$/.test(entry.id)||
      store.seen(entry.id))continue;
    const message=await fetchJson(fetcher,GMAIL+"/"+encodeURIComponent(entry.id)+"?format=full",{
      method:"GET",headers:{authorization:"Bearer "+accessToken},
    }).catch(()=>{throw Error("SLICE_GMAIL_MESSAGE_UNAVAILABLE");});
    examined++;
    const evidence=parseGmailMessage(message);
    if(!evidence){
      store.mark(entry.id,"UNPARSEABLE");review++;continue;
    }
    const response=await fetcher(ORIGIN+"/api/internal/slice-email/accept",{
      method:"POST",headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify(evidence),redirect:"error",cache:"no-store",
      signal:AbortSignal.timeout(10_000),
    });
    if(![200,202,409,422].includes(response.status))throw Error("EMAIL_APPROVAL_UNAVAILABLE");
    const decision=parseBody(await response.json());
    const ok=response.status===200 && decision.result==="APPROVED";
    store.mark(entry.id,ok?"APPROVED":"REVIEW_REQUIRED");
    if(ok)approved++;else review++;
  }
  return {eligible:snapshot.eligible.length,examined,approved,review};
}
async function main():Promise<void>{
  const env=process.env;
  if(!validProductionEnv(env)){console.error("slice_email_production_configuration_rejected");process.exitCode=1;return;}
  const {database,store}=sqliteSeenDb();
  const cache=new OAuthCache();
  let stopped=false;let failures=0;let cycles=0;
  process.on("SIGTERM",()=>{stopped=true;});
  process.on("SIGINT",()=>{stopped=true;});
  console.info(JSON.stringify({event:"slice_email_worker_started",intervalSeconds:5}));
  try{
    while(!stopped){
      cycles++;
      try{
        const result=await scanOnce(env,store,cache);
        failures=0;
        if(result.approved||result.review||cycles%30===1){
          console.info(JSON.stringify({event:"slice_email_scan",...result,cycles}));
        }
      }catch(error){
        failures++;
        const reason=error instanceof Error && [
          "SLICE_SNAPSHOT_UNAVAILABLE","SLICE_GMAIL_OAUTH_UNAVAILABLE",
          "SLICE_GMAIL_LIST_UNAVAILABLE","SLICE_GMAIL_MESSAGE_UNAVAILABLE",
          "EMAIL_APPROVAL_UNAVAILABLE","PRODUCTION_EMAIL_DISABLED",
          "OAUTH_TRANSPORT_ERROR","OAUTH_NONJSON_RESPONSE","OAUTH_INVALID_GRANT",
          "OAUTH_INVALID_CLIENT","OAUTH_UNAUTHORIZED_CLIENT","OAUTH_ACCESS_DENIED",
          "OAUTH_INVALID_SCOPE","OAUTH_PROVIDER_UNAVAILABLE","OAUTH_TOKEN_REJECTED",
          "OAUTH_INVALID_TOKEN_RESPONSE","OAUTH_SCOPE_MISMATCH",
        ].includes(error.message)?error.message:"slice_email_scan_unavailable";
        // Stage-only diagnosis; NEVER echo OAuth response, bank message,
        // account numbers, secret material or customer data.
        console.error(reason);
      }
      if(!stopped)await Bun.sleep(POLL_MS*2**Math.min(3,failures));
    }
  }finally{database.close();}
}
if(import.meta.main)await main();
