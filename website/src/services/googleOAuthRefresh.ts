/** Private Google OAuth refresh handler: only allowlisted errors leave this module. */
const TOKEN_URL = "https://oauth2.googleapis.com/token";
type Env = Readonly<Record<string, string | undefined>>;
type Fetcher = typeof fetch;

function parseBody(body:unknown):Record<string,unknown> {
  if (!body || typeof body!=="object" || Array.isArray(body)) {
    throw Error("OAUTH_INVALID_TOKEN_RESPONSE");
  }
  return body as Record<string,unknown>;
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
