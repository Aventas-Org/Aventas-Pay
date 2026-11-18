/** Durable Gmail dedup; exact, once-only opt-in replay for UNPARSEABLE records. */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
const PATH="/data/aventas-slice-credit-production.sqlite3";
export interface SeenStore {seen(id:string):boolean;mark(id:string,state:string):void;}
export function parseReplayIds(raw:string|undefined):ReadonlySet<string> {
  if(!raw||raw.trim()==="")return new Set<string>();
  const ids=raw.split(",").map(x=>x.trim());
  if(ids.length>5||new Set(ids).size!==ids.length||!ids.every(x=>/^[a-f0-9]{12,32}$/.test(x)))throw Error("INVALID_REPLAY_IDS");
  return new Set(ids);
}
export function sqliteSeenDb(path=PATH,replayIds:ReadonlySet<string>=new Set()):
  {database:Database;store:SeenStore}{
  if(!path.startsWith("/data/")&&!path.startsWith("/tmp/"))throw Error("BAD_VOLUME");
  mkdirSync(dirname(path),{recursive:true});
  const database=new Database(path,{create:true});
  database.run("PRAGMA journal_mode=WAL");
  database.run("CREATE TABLE IF NOT EXISTS processed_messages (gmail_id TEXT PRIMARY KEY,decision TEXT NOT NULL,processed_at INTEGER NOT NULL)");
  database.run("CREATE TABLE IF NOT EXISTS processed_replay_attempts (gmail_id TEXT PRIMARY KEY,attempted_at INTEGER NOT NULL)");
  const seenStmt=database.prepare("SELECT decision FROM processed_messages WHERE gmail_id=?");
  const replayStmt=database.prepare("INSERT OR IGNORE INTO processed_replay_attempts VALUES(?,?)");
  const markStmt=database.prepare("INSERT INTO processed_messages (gmail_id,decision,processed_at) VALUES(?,?,?) ON CONFLICT(gmail_id) DO UPDATE SET decision=excluded.decision,processed_at=excluded.processed_at WHERE processed_messages.decision='UNPARSEABLE' AND EXISTS (SELECT 1 FROM processed_replay_attempts WHERE gmail_id=excluded.gmail_id)");
  return {database,store:{
    seen:(id)=>{
      const row=seenStmt.get(id) as {decision:string}|null;
      if(!row)return false;
      if(row.decision!=="UNPARSEABLE"||!replayIds.has(id))return true;
      return replayStmt.run(id,Date.now()).changes===0;
    },
    mark:(id,state)=>{markStmt.run(id,state,Date.now());},
  }};
}
