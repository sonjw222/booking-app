import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake=vi.hoisted(()=>({authenticatedUid:vi.fn(),target:vi.fn(),admin:vi.fn(()=>({})),read:vi.fn()}));
vi.mock("../../lib/payments/server/nicepay/reviewWindowRuntime",()=>({reviewAdminClient:fake.admin,reviewReadPort:()=>fake.read(),reviewBearer:(r:Request)=>r.headers.get("authorization")?.replace(/^Bearer /,"")??null}));
import { POST } from "../../app/api/payments/nicepay/review-window/route";
import { POST as RETURN } from "../../app/api/payments/nicepay/review-window/return/route";
import { GET as RESULT } from "../../app/api/payments/nicepay/review-window/result/route";
import { REVIEW_UID } from "../../lib/payments/server/nicepay/reviewWindow";
const PRODUCT="33333333-3333-4333-8333-333333333333";
const request=(body:unknown,origin="https://mwhabit.com",auth=true)=>new Request("https://mwhabit.com/api/payments/nicepay/review-window",{method:"POST",headers:{origin,"content-type":"application/json",...(auth?{authorization:"Bearer jwt"}:{})},body:JSON.stringify(body)});
beforeEach(()=>{
 vi.clearAllMocks();fake.authenticatedUid.mockResolvedValue(REVIEW_UID);fake.target.mockResolvedValue({productId:PRODUCT,name:"상품",amount:1000});fake.read.mockReturnValue({authenticatedUid:fake.authenticatedUid,target:fake.target});
 for(const [k,v] of Object.entries({NICEPAY_REVIEW_WINDOW_ENABLED:"true",NICEPAY_CHECKOUT_ENABLED:"false",NEXT_PUBLIC_PG_CHECKOUT_ENABLED:"false",NICEPAY_REVIEW_TEST_MERCHANT_KEY:"A".repeat(86)+"==",NICEPAY_REVIEW_WINDOW_SECRET:"s".repeat(48)}))vi.stubEnv(k,v);
 vi.stubGlobal("fetch",vi.fn(()=>{throw Error("unexpected real network")}));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe("isolated review HTTP routes",()=>{
 it("is disabled without admin or external calls when the mode is off",async()=>{vi.stubEnv("NICEPAY_REVIEW_WINDOW_ENABLED","false");expect((await POST(request({productId:PRODUCT,action:"open"}))).status).toBe(404);expect(fake.admin).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();});
 it("rejects cross-origin, anonymous, malformed, oversized and unknown actions",async()=>{
  expect((await POST(request({productId:PRODUCT,action:"open"},"https://evil.test"))).status).toBe(403);
  expect((await POST(request({productId:PRODUCT,action:"open"},"https://mwhabit.com",false))).status).toBe(403);
  expect((await POST(request({productId:PRODUCT,action:"approve"}))).status).toBe(400);
  expect((await POST(request({productId:PRODUCT,action:"check",extra:"x".repeat(4100)}))).status).toBe(413);
  expect((await POST(new Request("https://mwhabit.com",{method:"POST",headers:{origin:"https://mwhabit.com"},body:"broken"}))).status).toBe(400);
 });
 it("uses server product/price regardless of submitted amount/center/name and never calls fetch",async()=>{
  const r=await POST(request({productId:PRODUCT,action:"open",amount:1,centerId:"other",orderName:"forged"}));expect(r.status).toBe(200);const body=await r.json();expect(body.params.Amt).toBe("1000");expect(body.params.GoodsName).toBe("상품");expect(body.params.MID).toBe("nicepay00m");expect(fetch).not.toHaveBeenCalled();
 });
 it("result accepts signed server outcomes only, omits tokens/form values, and disables scripts",async()=>{
  const opened=await POST(request({productId:PRODUCT,action:"open"}));const {params}=await opened.json();
  const response=await RETURN(new Request(params.ReturnURL,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({Moid:params.Moid,AuthResultCode:"9999",GoodsName:"<script>evil</script>"})}));
  const result=await RESULT(new Request(response.headers.get("location")!));const html=await result.text();expect(html).toContain("테스트 결제창 종료");expect(html).not.toContain("evil");expect(html).not.toContain("rt=");expect(html).not.toContain("<script");expect(result.headers.get("cache-control")).toBe("no-store");expect(result.headers.get("content-security-policy")).toContain("default-src 'none'");
  const forged=await RESULT(new Request("https://mwhabit.com/api/payments/nicepay/review-window/result?rt=forged&status=paid"));expect(await forged.text()).toContain("테스트 복귀 정보 확인 불가");expect(fetch).not.toHaveBeenCalled();
 });
 it("untrusted return URLs/tokens cannot redirect outside the generic test result or call approval",async()=>{
  const r=await RETURN(new Request("https://mwhabit.com/api/payments/nicepay/review-window/return?rt=forged",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:"AuthResultCode=0000&Moid=forged&NextAppURL=https%3A%2F%2Fevil.test"}));expect(r.status).toBe(303);expect(r.headers.get("location")).toBe("https://mwhabit.com/api/payments/nicepay/review-window/result");expect(fetch).not.toHaveBeenCalled();expect(fake.target).not.toHaveBeenCalled();
 });
});
