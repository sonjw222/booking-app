// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const h=vi.hoisted(()=>({token:"jwt",callback:null as null|(()=>void),open:vi.fn(),fetch:vi.fn(),params:{MID:"nicepay00m",Moid:"33333333-3333-4333-8333-333333333333",Amt:"1000",GoodsName:"상품",EdiDate:"20261105140000",SignData:"a".repeat(64),ReturnURL:"https://mwhabit.com/api/payments/nicepay/review-window/return?rt=fake",PayMethod:"CARD",CharSet:"utf-8"}}));
vi.mock("../../lib/supabaseClient",()=>({supabase:{auth:{getSession:async()=>({data:{session:h.token?{access_token:h.token,user:{email:h.token==="jwt"?"niceqa@mwhabit.com":"other@test.invalid"}}:null}}),onAuthStateChange:(f:()=>void)=>{h.callback=f;return {data:{subscription:{unsubscribe:vi.fn()}}}}}}}));
vi.mock("../../lib/payments/nicepayV3Window",()=>({NICEPAY_V3_SDK_URL:"https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js",openNicepayV3Window:h.open}));
// Pure response validation is tested separately; this suite isolates async UI/session behavior.
vi.mock("../../lib/payments/reviewWindowClient",()=>({validateReviewWindowParams:(p:unknown)=>p}));
import NicepayReviewWindow from "../../app/components/NicepayReviewWindow";
let root:Root, host:HTMLDivElement;
const response=(body:unknown)=>({ok:true,json:async()=>body});
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.clearAllMocks();h.token="jwt";h.callback=null;h.fetch.mockImplementation(async(_url:string,init:RequestInit)=>response(JSON.parse(String(init.body)).action==="check"?{allowed:h.token==="jwt"}:{allowed:true,params:h.params}));vi.stubGlobal("fetch",h.fetch);(window as unknown as {goPay:()=>void}).goPay=()=>{};host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(createElement(NicepayReviewWindow,{productId:"33333333-3333-4333-8333-333333333333"})));}
async function click(){const b=host.querySelector("button")!;await act(async()=>b.dispatchEvent(new MouseEvent("click",{bubbles:true})));}
describe("review window UI only",()=>{
 it("stays absent and loads no SDK when not allowed",async()=>{h.token="other";await render();expect(host.querySelector("button")).toBeNull();expect(h.fetch).not.toHaveBeenCalled();expect(h.open).not.toHaveBeenCalled();expect(document.querySelector('script[src*="nicepay"]')).toBeNull();});
 it("requires an explicit click; double clicks open once and close never creates/abandons an order",async()=>{
  await render();expect(host.textContent).toContain("카드번호나 카드 인증정보를 입력하지 마세요");expect(h.open).not.toHaveBeenCalled();const b=host.querySelector("button")!;
  await act(async()=>{b.dispatchEvent(new MouseEvent("click",{bubbles:true}));b.dispatchEvent(new MouseEvent("click",{bubbles:true}));});expect(h.open).toHaveBeenCalledTimes(1);
  await act(async()=>h.open.mock.calls[0][1].onClosedBeforeSubmit());expect(host.textContent).toContain("주문과 이용권을 생성하지 않았습니다");expect(h.fetch.mock.calls.every((c:unknown[])=>c[0]==="/api/payments/nicepay/review-window")).toBe(true);
  expect(h.fetch.mock.calls.filter((c:unknown[])=>JSON.parse(String((c[1] as RequestInit).body)).action==="open")).toHaveLength(1);
 });
 it("rejects an in-flight open when the logged-in account changes",async()=>{
  let resolve!:(value:unknown)=>void;const pending=new Promise(r=>{resolve=r});
  h.fetch.mockImplementation(async(_url:string,init:RequestInit)=>JSON.parse(String(init.body)).action==="open"?pending:response({allowed:h.token==="jwt"}));
  await render();await click();await act(async()=>{h.token="other";h.callback!();resolve(response({allowed:true,params:h.params}));});expect(h.open).not.toHaveBeenCalled();expect(host.querySelector("button")).toBeNull();
 });
});
