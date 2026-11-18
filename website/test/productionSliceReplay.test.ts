import { describe,expect,test } from "bun:test";
import { rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { parseReplayIds,sqliteSeenDb } from "../src/services/sliceGmailSeenStore";
const id="a1b2c3d4e5f60718",other="1234567890abcdef";
function fixture() {
  const path="/tmp/aventas-replay-"+crypto.randomUUID()+".sqlite3";
  const entry=sqliteSeenDb(path);
  return {path,...entry,close:()=>{entry.database.close();rmSync(path,{force:true});}};
}
describe("durable one-shot Gmail UNPARSEABLE replay",()=>{
  test("without explicit allowlist all processed decisions remain terminal",()=>{
    const c=fixture();
    try {
      expect(c.store.seen(id)).toBe(false);
      c.store.mark(id,"UNPARSEABLE");
      expect(c.store.seen(id)).toBe(true);
      c.store.mark(id,"APPROVED");
      expect(c.database.prepare("SELECT decision FROM processed_messages WHERE gmail_id=?").get(id)).toEqual({decision:"UNPARSEABLE"});
    }finally{c.close();}
  });
  test("exact allowlisted unparseable record replays once, never twice, and updates the decision",()=>{
    const c=fixture();
    try {
      c.store.mark(id,"UNPARSEABLE");
      c.database.close();
      const r=sqliteSeenDb(c.path,parseReplayIds(id));
      try{
        expect(r.store.seen(id)).toBe(false);
        expect(r.store.seen(id)).toBe(true);
        r.store.mark(id,"REVIEW_REQUIRED");
        expect(r.store.seen(id)).toBe(true);
        expect(r.database.prepare("SELECT decision FROM processed_messages WHERE gmail_id=?").get(id)).toEqual({decision:"REVIEW_REQUIRED"});
        expect(r.database.prepare("SELECT COUNT(*) AS n FROM processed_replay_attempts").get()).toEqual({n:1});
      }finally{r.database.close();}
    }finally{rmSync(c.path,{force:true});}
  });
  test("APPROVED and REVIEW_REQUIRED are never replayable even when allowlisted",()=>{
    const c=fixture();
    try {
      c.store.mark(id,"APPROVED");c.store.mark(other,"REVIEW_REQUIRED");
      c.database.close();
      const r=sqliteSeenDb(c.path,parseReplayIds(id+","+other));
      try {
        expect(r.store.seen(id)).toBe(true);
        expect(r.store.seen(other)).toBe(true);
        expect(r.database.prepare("SELECT COUNT(*) AS n FROM processed_replay_attempts").get()).toEqual({n:0});
      }finally{r.database.close();}
    }finally{rmSync(c.path,{force:true});}
  });
  test("legacy processed_messages table migrates without losing previous decisions",()=>{
    const c=fixture();
    try{
      c.store.mark(id,"UNPARSEABLE");
      c.database.close();
      const r=sqliteSeenDb(c.path);
      try{expect(r.store.seen(id)).toBe(true);}finally{r.database.close();}
    }finally{rmSync(c.path,{force:true});}
  });
  test("rejects bulk, duplicated, or invalid Gmail ids",()=>{
    expect(parseReplayIds(undefined).size).toBe(0);
    expect(parseReplayIds("").size).toBe(0);
    expect(parseReplayIds(" "+id+" ").has(id)).toBe(true);
    expect(()=>parseReplayIds(id+","+id)).toThrow("INVALID_REPLAY_IDS");
    expect(()=>parseReplayIds("not a gmail id")).toThrow("INVALID_REPLAY_IDS");
    expect(()=>parseReplayIds(Array(6).fill(id).map((x,i)=>x+i).join(","))).toThrow("INVALID_REPLAY_IDS");
  });
  test("refuses non-volume paths",()=>{expect(()=>sqliteSeenDb("/var/secrets/payment.sqlite")).toThrow("BAD_VOLUME");});
});