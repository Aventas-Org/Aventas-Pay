/**
 * Isolated Railway production Slice credit-email scanner. Uses the existing
 * gmail.readonly OAuth grant, and only speaks to pay.aventasgaming.com with a
 * dedicated secret. No public listener, no raw mail body/secrets in logs.
 *
 * This is a merchant-authorized EMAIL approval policy; it does not certify
 * that bank funds settled. Immutable D1 approval + bot CAS gate fulfillment.
 */
import { OAuthCache } from "../src/services/googleOAuthRefresh.ts";
import { parseGmailMessage } from "../src/services/sliceGmailMessage.ts";
import { sqliteSeenDb, parseReplayIds } from "../src/services/sliceGmailSeenStore.ts";
import type { SeenStore } from "../src/services/sliceGmailSeenStore.ts";

const ORIGIN = "https://pay.aventasgaming.com";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const POLL_MS = 5_000;
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
  let replayIds:ReadonlySet<string>;
  try {replayIds=parseReplayIds(env.SLICE_EMAIL_REPLAY_UNPARSEABLE_IDS);}
  catch {console.error("slice_email_replay_configuration_rejected");process.exitCode=1;return;}
  const {database,store}=sqliteSeenDb(undefined,replayIds);
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
