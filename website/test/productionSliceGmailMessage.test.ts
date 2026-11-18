import { describe,expect,test } from "bun:test";
import { parseGmailMessage } from "../src/services/sliceGmailMessage";

const encode=(v:string)=>Buffer.from(v,"utf8").toString("base64url");
const id="a1b2c3d4e5f60718";
const timestamp="1794987846000";
const headers=[
  {name:"From",value:"slice <noreply@slice.bank.in>"},
  {name:"Subject",value:"Received ₹321.36 in your slice account"},
  {name:"Authentication-Results",value:"mx.google.com; dkim=pass header.i=@slice.bank.in; dmarc=pass header.from=slice.bank.in"},
];
function msg(payload:unknown) {
  return {id,internalDate:timestamp,payload:{...(payload as object),headers}};
}
const html="<html><head><style>evil{} </style></head><body><table><tr><td>You have received &#8377;321.36 via UPI in your slice bank account xx6828.</td></tr><tr><td>RRN</td></tr><tr><td>123456789012</td></tr></table><script>steal data</script></body></html>";
const credit=/You have received\s+₹321\.36\s+via UPI in your slice bank account\s+xx6828\b/;
const rrn=/\bRRN\s*\r?\n\s*123456789012\b/;
describe("production Gmail message parser - fail closed HTML-only Slice receipts",()=>{
  test("extracts HTML-only Slice credit amount, account and RRN as text",()=>{
    const out=parseGmailMessage(msg({mimeType:"text/html",body:{data:encode(html)}}));
    expect(out?.body).toBeString();
    expect(credit.test(String(out?.body))).toBe(true);
    expect(rrn.test(String(out?.body))).toBe(true);
    expect(String(out?.body)).not.toContain("steal data");
    expect(String(out?.body)).not.toContain("evil{}");
    expect(out?.authentication_results).toContain("dkim=pass");
    expect(out?.from).toBe("slice <noreply@slice.bank.in>");
    expect(out?.internal_date_ms).toBe(1794987846000);
    expect(out?.gmail_message_id).toBe(id);
  });
  test("prefers text/plain when valid multipart/alternative includes HTML",()=>{
    const plain="You have received ₹321.36 via UPI in your slice bank account xx6828\nRRN\n123456789012";
    const payload={mimeType:"multipart/alternative",parts:[
      {mimeType:"text/html",body:{data:encode("<p>Different amount: ₹321.35</p>")}},
      {mimeType:"text/plain",body:{data:encode(plain)}},
    ]};
    expect(parseGmailMessage(msg(payload))?.body).toBe(plain);
  });
  test("uses HTML part from nested multipart when no plain-text part exists",()=>{
    const nested={mimeType:"multipart/mixed",parts:[{mimeType:"multipart/alternative",parts:[
      {mimeType:"text/html",body:{data:encode(html)}},
    ]}]};
    expect(credit.test(String(parseGmailMessage(msg(nested))?.body))).toBe(true);
  });
  test("decodes HTML entities and whitespace without invoking markup",()=>{
    const body="<html><body><p>Received &amp; confirmed &#x20b9;321.36 &nbsp; &lt;b&gt;safe&lt;/b&gt;</p><p>RRN<br/>123456789012</p></body></html>";
    const out=parseGmailMessage(msg({mimeType:"text/html",body:{data:encode(body)}}));
    expect(out?.body).toContain("Received & confirmed ₹321.36");
    expect(out?.body).toContain("<b>safe</b>");
    expect(String(out?.body)).toMatch(rrn);
  });
  test("falls closed for scripts only, malformed MIME and oversized decoded evidence",()=>{
    expect(parseGmailMessage(msg({mimeType:"text/html",body:{data:encode("<html><script>fake credit</script></html>")}}))).toBeNull();
    expect(parseGmailMessage(msg({mimeType:"text/html",body:{data:"%%%"}}))).toBeNull();
    expect(parseGmailMessage(msg({mimeType:"text/html",body:{data:encode("X".repeat(65_000))}}))).toBeNull();
    expect(parseGmailMessage(msg({mimeType:"text/plain",body:{data:encode("X".repeat(13_000))}}))).toBeNull();
  });
  test("rejects invalid Gmail identities and unstructured messages",()=>{
    expect(parseGmailMessage({...msg({mimeType:"text/plain",body:{data:encode("Hi")}}),id:"invalid"})).toBeNull();
    expect(parseGmailMessage({...msg({mimeType:"text/plain",body:{data:encode("Hi")}}),internalDate:"bad"})).toBeNull();
    expect(parseGmailMessage(null)).toBeNull();
    expect(parseGmailMessage(msg({mimeType:"multipart/mixed",parts:[{mimeType:"image/png",body:{data:encode("fake")}}]}))).toBeNull();
  });
  test("normalizes MIME encoded subject without changing authentication checks",()=>{
    const encoded=Buffer.from("Received ₹321.36 in your slice account").toString("base64");
    const obj=msg({mimeType:"text/plain",body:{data:encode("Test")}});
    obj.payload.headers=[...headers.slice(0,1),{name:"Subject",value:"=?UTF-8?B?"+encoded+"?="},headers[2]!];
    expect(parseGmailMessage(obj)?.subject).toBe("Received ₹321.36 in your slice account");
  });
});