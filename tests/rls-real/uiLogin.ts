/* 격리 PostgREST 브라우저 테스트용 로그인: 실제 서명된 JWT(authenticated, sub)를 localStorage 세션으로 넣는다. 운영/공유 DEV 접속 없음. */
import { createHmac } from "node:crypto";
import type { Page } from "@playwright/test";

const SECRET = "qa-secret-qa-secret-qa-secret-1234567890";
const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const uiJwt = (sub: string) => { const h = b({ alg: "HS256", typ: "JWT" }), p = b({ role: "authenticated", iss: "qa", exp: 4102444800, sub, aud: "authenticated" }); return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`; };
export async function loginAs(page: Page, sub: string, email = "qa@test.invalid") {
  await page.addInitScript(([t, id, em]) => {
    const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
    localStorage.setItem("sb-127-auth-token", JSON.stringify({ access_token: t, refresh_token: "r", expires_at: exp, expires_in: 86400, token_type: "bearer", user: { id, aud: "authenticated", email: em, app_metadata: { provider: "email" }, user_metadata: {} } }));
  }, [uiJwt(sub), sub, email] as const);
}
