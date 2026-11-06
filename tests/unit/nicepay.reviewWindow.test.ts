import { afterEach, describe, expect, it, vi } from "vitest";
import { finishReviewWindow, prepareReviewWindow, REVIEW_MID, REVIEW_UID, reviewWindowConfig, verifyReviewAttempt, type ReviewReadPort } from "../../lib/payments/server/nicepay/reviewWindow";
import { verifyReturnToken } from "../../lib/payments/server/returnToken";
import { nicepaySign } from "../../lib/payments/server/nicepay/signature";
import { validateReviewWindowParams } from "../../lib/payments/reviewWindowClient";
const PRODUCT = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-11-05T05:00:00Z"), sec = now.getTime()/1000;
const c = { merchantKey: "A".repeat(86)+"==", secret: "s".repeat(48) };
const env = { NICEPAY_REVIEW_WINDOW_ENABLED:"true", NICEPAY_CHECKOUT_ENABLED:"false", NEXT_PUBLIC_PG_CHECKOUT_ENABLED:"false", NICEPAY_REVIEW_TEST_MERCHANT_KEY:c.merchantKey, NICEPAY_REVIEW_WINDOW_SECRET:c.secret };
const port = (): ReviewReadPort => ({ authenticatedUid:vi.fn(async()=>REVIEW_UID), target:vi.fn(async()=>({productId:PRODUCT,name:"심사 상품",amount:1000})) });
async function attempt(p=port()) {
 const r=await prepareReviewWindow({token:"session",productId:PRODUCT,open:true},c,p,now);
 if(!r || !("params" in r)) throw Error("fixture");
 const rt=new URL(r.params.ReturnURL).searchParams.get("rt")!;
 return {params:r.params,rt};
}
const authForm = (params: Awaited<ReturnType<typeof attempt>>["params"]) => ({Moid:params.Moid,MID:REVIEW_MID,Amt:"1000",AuthResultCode:"0000",AuthToken:"fake-auth",TxTid:"fake-tid",Signature:nicepaySign.authResult({authToken:"fake-auth",mid:REVIEW_MID,amt:"1000"},c.merchantKey),NextAppURL:"https://pg-api.nicepay.co.kr/webapi/pay_process.jsp"});
afterEach(()=>vi.unstubAllGlobals());
describe("existing App Store app: read-only review window",()=>{
 it("is absent by default and requires both real-payment switches to remain off",()=>{
  expect(reviewWindowConfig({})).toBeNull();expect(reviewWindowConfig(env)).toEqual(c);
  for(const key of Object.keys(env))expect(reviewWindowConfig({...env,[key]:undefined})).toBeNull();
  for(const key of ["NICEPAY_CHECKOUT_ENABLED","NEXT_PUBLIC_PG_CHECKOUT_ENABLED"])expect(reviewWindowConfig({...env,[key]:"true"})).toBeNull();
  expect(reviewWindowConfig({...env,NICEPAY_REVIEW_TEST_MERCHANT_KEY:"bad"})).toBeNull();
  expect(reviewWindowConfig({...env,NICEPAY_MID:"unrelated",NICEPAY_MERCHANT_KEY:"not-used",NICEPAY_ENV:"production"})).toEqual(c);
 });
 it("denies anonymous and other accounts before reading a product",async()=>{
  const p=port();expect(await prepareReviewWindow({token:null,productId:PRODUCT,open:true},c,p,now)).toBeNull();
  vi.mocked(p.authenticatedUid).mockResolvedValue("other-account");
  expect(await prepareReviewWindow({token:"session",productId:PRODUCT,open:true},c,p,now)).toBeNull();expect(p.target).not.toHaveBeenCalled();
 });
 it("hides on permission/product rejection or invalid price; capability never includes payment parameters",async()=>{
  const p=port();expect(await prepareReviewWindow({token:"s",productId:PRODUCT,open:false},c,p,now)).toEqual({allowed:true});
  vi.mocked(p.target).mockResolvedValue(null);expect(await prepareReviewWindow({token:"s",productId:PRODUCT,open:true},c,p,now)).toBeNull();
  for(const amount of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){vi.mocked(p.target).mockResolvedValue({productId:PRODUCT,name:"x",amount});expect(await prepareReviewWindow({token:"s",productId:PRODUCT,open:true},c,p,now)).toBeNull();}
 });
 it("uses only test MID, server price, unique attempt and dedicated HTTPS return; no key leaks",async()=>{
  const a=await attempt(),b=await attempt();expect(a.params.MID).toBe("nicepay00m");expect(verifyReturnToken(c.secret,a.rt,a.params.Moid,sec).ok).toBe(false);expect(a.params.Amt).toBe("1000");expect(a.params.EdiDate).toBe("20261105140000");expect(a.params.Moid).not.toBe(b.params.Moid);
  expect(a.params.ReturnURL).toMatch(/^https:\/\/mwhabit.com\/api\/payments\/nicepay\/review-window\/return\?rt=/);
  expect(JSON.stringify(a.params)).not.toContain(c.merchantKey);expect(JSON.stringify(a.params)).not.toContain(c.secret);
 });
 it("rejects tampering, expiry at boundary, future issue time and using result tokens as auth attempts",async()=>{
  const {rt,params}=await attempt();expect(verifyReviewAttempt(rt,c,sec)).not.toBeNull();expect(verifyReviewAttempt(rt+"x",c,sec)).toBeNull();expect(verifyReviewAttempt(rt,c,sec+600)).toBeNull();expect(verifyReviewAttempt(rt,c,sec-1)).toBeNull();
  const location=await finishReviewWindow(authForm(params),rt,c,port(),sec);
  const resultRt=new URL(location).searchParams.get("rt")!;
  expect(verifyReviewAttempt(resultRt,c,sec)?.outcome).toBe("verified-not-approved");
  expect(new URL(await finishReviewWindow(authForm(params),resultRt,c,port(),sec)).search).toBe("");
 });
 it("valid auth and repeated posts never call a network or approval port, nor report paid",async()=>{
  const fetch=vi.fn(()=>{throw Error("real network forbidden")});vi.stubGlobal("fetch",fetch);
  const {rt,params}=await attempt();const p=port();
  for(let i=0;i<2;i++){const loc=await finishReviewWindow(authForm(params),rt,c,p,sec);expect(verifyReviewAttempt(new URL(loc).searchParams.get("rt"),c,sec)?.outcome).toBe("verified-not-approved");expect(loc).not.toContain("paid");}
  expect(fetch).not.toHaveBeenCalled();expect(Object.keys(p).sort()).toEqual(["authenticatedUid","target"]);
 });
 it("auth success requires exact attempt/MID/Amt and signature, with current account/product permission",async()=>{
  const {rt,params}=await attempt();const f=authForm(params);
  for(const [key,value] of [["Moid",PRODUCT],["MID","other"],["Amt","999"],["Signature","a".repeat(64)],["AuthToken",""],["TxTid",""]])expect(new URL(await finishReviewWindow({...f,[key]:value},rt,c,port(),sec)).search).toBe("");
  const p=port();vi.mocked(p.target).mockResolvedValue(null);expect(new URL(await finishReviewWindow(f,rt,c,p,sec)).search).toBe("");
  vi.mocked(p.target).mockResolvedValue({productId:PRODUCT,name:"changed",amount:999});expect(new URL(await finishReviewWindow(f,rt,c,p,sec)).search).toBe("");
 });
 it("cancel is a signed informational result, never a DB order cancellation",async()=>{
  const {rt,params}=await attempt();const loc=await finishReviewWindow({Moid:params.Moid,AuthResultCode:"9999"},rt,c,port(),sec);
  expect(verifyReviewAttempt(new URL(loc).searchParams.get("rt"),c,sec)?.outcome).toBe("closed");
 });
 it("browser rejects real approval ReturnURL, other hosts, invalid MID and injected extra fields",async()=>{
  const {params}=await attempt();expect(validateReviewWindowParams(params,"https://mwhabit.com")).toEqual(params);
  for(const p of [{...params,ReturnURL:params.ReturnURL.replace("/review-window","")},{...params,ReturnURL:params.ReturnURL.replace("mwhabit.com","evil.test")},{...params,MID:"other"},{...params,ReturnURL:params.ReturnURL+"&rt=duplicate"},{...params,Amt:"0001000"}])expect(validateReviewWindowParams(p,"https://mwhabit.com")).toBeNull();
  expect(validateReviewWindowParams(params,"https://preview.test")).toBeNull();expect(validateReviewWindowParams({...params,MerchantKey:"injected"},"https://mwhabit.com")).not.toHaveProperty("MerchantKey");
 });
});

// ── 실제 센터 상품 허용(centerId 포함 Target) — 시도 토큰은 상품의 센터를 담고, 반환 시 같은 센터로 다시 검증한다 ──
import { prepareReviewWindow as _prepare, finishReviewWindow as _finish, verifyReviewAttempt as _verify, REVIEW_UID as _UID } from "../../lib/payments/server/nicepay/reviewWindow";
describe("실제 센터 상품 시도 토큰", () => {
  const cfg = { merchantKey: "k".repeat(86) + "==", secret: "s".repeat(40) };
  const RC = "8965e09c-0d2b-44c6-ab26-40a85507f8b5", RP = "44444444-4444-4444-8444-444444444444";
  const mk = (centerId?: string) => ({ authenticatedUid: async () => _UID, target: async () => ({ productId: RP, name: "11월 수강권", amount: 80000, ...(centerId ? { centerId } : {}) }) });
  it("토큰에 센터가 들어가고 반환 시 같은 센터·금액이어야 통과, 다른 센터로 바뀌면 무효", async () => {
    const now = new Date("2026-11-06T03:00:00Z");
    const r = await _prepare({ token: "t", productId: RP, open: true }, cfg, mk(RC), now) as { params: { Amt: string; Moid: string; ReturnURL: string } };
    expect(r.params.Amt).toBe("80000"); const rt = new URL(r.params.ReturnURL).searchParams.get("rt")!;
    expect(_verify(rt, cfg, Math.floor(now.getTime() / 1000) + 1)?.center).toBe(RC);
    const ok = await _finish({ AuthResultCode: "2001", Moid: r.params.Moid }, rt, cfg, mk(RC), Math.floor(now.getTime() / 1000) + 1);
    expect(ok).toContain("/result?rt=");
    const bad = await _finish({ AuthResultCode: "2001", Moid: r.params.Moid }, rt, cfg, mk("99999999-9999-4999-8999-999999999999"), Math.floor(now.getTime() / 1000) + 1);
    expect(bad.endsWith("/result")).toBe(true);
    const legacy = await _finish({ AuthResultCode: "2001", Moid: r.params.Moid }, rt, cfg, mk(undefined), Math.floor(now.getTime() / 1000) + 1);
    expect(legacy.endsWith("/result")).toBe(true);   // 센터 id 가 없는(심사 센터) 대상으로는 실제 센터 토큰이 통과하지 못한다
  });
});
