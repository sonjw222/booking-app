import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reviewReadPort } from "../../lib/payments/server/nicepay/reviewWindowRuntime";
import { REVIEW_CENTER, REVIEW_EMAIL, REVIEW_UID } from "../../lib/payments/server/nicepay/reviewWindow";
const PRODUCT="33333333-3333-4333-8333-333333333333";
function fixture(){
 const user={id:REVIEW_UID,email:REVIEW_EMAIL,email_confirmed_at:"2026-10-30"};
 const rows:Record<string,Record<string,unknown>|null>={accounts:{nicepay_review_access:true,is_member:true,deactivated_at:null,merged_into:null},centers:{is_nicepay_review:true,is_internal:false,status:"approved"},products:{id:PRODUCT,center_id:REVIEW_CENTER,name:"상품",price:1000,is_active:true,is_on_sale:true}};
 const filters:unknown[]=[];
 const admin={auth:{getUser:vi.fn(async()=>({data:{user},error:null})),admin:{getUserById:vi.fn(async()=>({data:{user},error:null}))}},from:vi.fn((table:string)=>({select:vi.fn(()=>({eq:vi.fn((key:string,value:string)=>{filters.push([table,key,value]);return {maybeSingle:vi.fn(async()=>({data:rows[table],error:null}))}})}))}))};
 return {user,rows,filters,admin,port:reviewReadPort(admin as unknown as SupabaseClient)};
}
describe("review scope read adapter",()=>{
 it("allows only the confirmed pinned email/UID and pins all table filters",async()=>{
  const f=fixture();expect(await f.port.authenticatedUid("jwt")).toBe(REVIEW_UID);expect(await f.port.target(REVIEW_UID,PRODUCT)).toEqual({productId:PRODUCT,name:"상품",amount:1000});
  expect(f.filters).toEqual([["accounts","auth_id",REVIEW_UID],["centers","id",REVIEW_CENTER],["products","id",PRODUCT]]);
  expect(await f.port.target("other",PRODUCT)).toBeNull();
  f.user.email="other@test.invalid";expect(await f.port.authenticatedUid("jwt")).toBeNull();expect(await f.port.target(REVIEW_UID,PRODUCT)).toBeNull();
 });
 it.each([
  ["accounts","nicepay_review_access",false],["accounts","is_member",false],["accounts","deactivated_at","now"],["accounts","merged_into","other"],
  ["centers","is_nicepay_review",false],["centers","is_internal",true],["centers","status","pending"],
  ["products","center_id","other"],["products","id","other"],["products","is_active",false],["products","is_on_sale",false],["products","price",0],
 ])("rejects %s.%s=%s",async(table,key,value)=>{const f=fixture();f.rows[String(table)]![String(key)]=value;expect(await f.port.target(REVIEW_UID,PRODUCT)).toBeNull();});
 it("fails closed on missing rows and unconfirmed users",async()=>{const f=fixture();f.rows.accounts=null;expect(await f.port.target(REVIEW_UID,PRODUCT)).toBeNull();f.user.email_confirmed_at="";expect(await f.port.authenticatedUid("jwt")).toBeNull();});
});
