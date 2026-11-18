import { describe, expect, test } from "bun:test";
import { OAuthCache } from "../src/services/googleOAuthRefresh";

const oauthEnv = {
  GMAIL_OAUTH_CLIENT_ID: "test-client-id-not-real",
  GMAIL_OAUTH_CLIENT_SECRET: "private-test-secret",
  GMAIL_OAUTH_REFRESH_TOKEN: "private-test-refresh-token",
};
const json = (body: unknown, status=200) => new Response(JSON.stringify(body),{
  status, headers:{"content-type":"application/json"},
});
const mock = (body: unknown, status=200) => (async (url: RequestInfo|URL,init?:RequestInit) => {
  expect(String(url)).toBe("https://oauth2.googleapis.com/token");
  expect(init?.method).toBe("POST");
  expect(String(init?.body)).toContain("grant_type=refresh_token");
  return json(body,status);
}) as typeof fetch;

describe("private Gmail refresh-token OAuth handling", () => {
  test("accepts Google Bearer token with required scope and extra granted scopes", async () => {
    const oauth = new OAuthCache();
    const token = await oauth.token(oauthEnv, mock({
      token_type: "Bearer",
      access_token: "opaque-access-token-12345",
      expires_in: 3600,
      scope: "openid https://www.googleapis.com/auth/gmail.readonly email",
    }));
    expect(token).toBe("opaque-access-token-12345");
    const second=await oauth.token(oauthEnv, (async()=>{throw Error("unexpected refresh");}) as typeof fetch);
    expect(second).toBe(token);
  });
  test("accepts Google's valid reply when refresh response omits scope", async () => {
    const token=await new OAuthCache().token(oauthEnv,mock({
      token_type:"bearer", access_token:"another-opaque-token", expires_in:3599,
    }));
    expect(token).toBe("another-opaque-token");
  });
  test("rejects response without the required gmail.readonly permission", async () => {
    await expect(new OAuthCache().token(oauthEnv,mock({
      token_type:"Bearer",access_token:"opaque-access-token",expires_in:3599,
      scope:"openid email",
    }))).rejects.toThrow("OAUTH_SCOPE_MISMATCH");
  });
  test("classifies revoked/expired refresh tokens without logging provider descriptions", async () => {
    await expect(new OAuthCache().token(oauthEnv,mock({
      error:"invalid_grant",error_description:"A SECRET SHOULD NEVER BE IN LOGS",
    },400))).rejects.toThrow("OAUTH_INVALID_GRANT");
  });
  test("classifies wrong client secret separately without exposing values", async () => {
    await expect(new OAuthCache().token(oauthEnv,mock({
      error:"invalid_client",error_description:"secret-containing-diagnostic",
    },401))).rejects.toThrow("OAUTH_INVALID_CLIENT");
  });
  test("denies malformed successful responses", async () => {
    await expect(new OAuthCache().token(oauthEnv,mock({
      token_type:"Bearer",access_token:"x",expires_in:3600,
    }))).rejects.toThrow("OAUTH_INVALID_TOKEN_RESPONSE");
  });
  test("distinguishes transport failures from credential errors", async () => {
    const fetcher=(async()=>{throw Error("network failure details with token");}) as typeof fetch;
    await expect(new OAuthCache().token(oauthEnv,fetcher))
      .rejects.toThrow("OAUTH_TRANSPORT_ERROR");
  });
});
