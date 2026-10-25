/* 시각 QA 스펙 공용 시드(격리 DB 전용). 모든 행은 고정 UUID 접두로 만들고 cleanup 에서 지운다. */
import { ID, sql } from "./support";

export const P = { pass: "e9c00000-0000-0000-0000-0000000000f1", pass2: "e9c00000-0000-0000-0000-0000000000f2" };
export const M = { a1: "e9c10000-0000-0000-0000-0000000000f1", a2: "e9c10000-0000-0000-0000-0000000000f2", a3: "e9c10000-0000-0000-0000-0000000000f3" };
export const CLS = (n: number) => `e9c20000-0000-0000-0000-${String(n).padStart(12, "0")}`;
export const CATS = ["피겨스케이팅", "필라테스", "발레", "리듬체조", "요가", "복싱", "수영", "골프", "테니스"];

export function seedVisualQa() {
  sql(`insert into products(id,center_id,name,price,product_kind,total_count,is_active,is_on_sale) values ('${P.pass}','${ID.centerPub}','[QA] 시각 수강권',50000,'pass',10,true,true) on conflict (id) do nothing`);
  // 가족 프로필(자녀A) 수강권 → 마이 카드에 프로필 배지가 표시된다. 매우 긴 프로필 이름도 한 건 포함한다.
  sql(`update profiles set name='자녀A 아주아주긴이름의프로필배지검증용' where id='${ID.pA2}'`);
  sql(`insert into memberships(id,profile_id,center_id,product_id,product_name,total_count,remaining_count,status,pass_type,expires_at) values ('${M.a1}','${ID.pA1}','${ID.centerPub}','${P.pass}','[QA] 시각 수강권',10,7,'active','count',(current_date+30)),('${M.a2}','${ID.pA2}','${ID.centerPub}','${P.pass}','[QA] 시각 수강권',10,3,'active','count',(current_date+30)) on conflict (id) do nothing`);
  CATS.forEach((c, i) => sql(`insert into service_categories(label,sort_order) values ('${c}',${i}) on conflict (label) do nothing`));
  // 일정 복사 원본: 이번 달 수업 12개(긴 제목 포함)
  for (let i = 1; i <= 12; i++) sql(`insert into classes(id,center_id,title,start_time,end_time,capacity,status,pass_selection_mode,booking_deadline_min) values ('${CLS(i)}','${ID.centerPub}','${i === 1 ? "[QA] 아주 긴 수업 이름 — 일정 복사 목록에서 줄바꿈과 말줄임을 확인하는 제목" : `[QA] 복사 원본 ${i}`}',(date_trunc('month', now() at time zone 'Asia/Seoul') + interval '${i} days 10 hours') at time zone 'Asia/Seoul',(date_trunc('month', now() at time zone 'Asia/Seoul') + interval '${i} days 11 hours') at time zone 'Asia/Seoul',5,'open','all',0) on conflict (id) do nothing`);
}
export function cleanupVisualQa() {
  sql(`delete from classes where id::text like 'e9c20000-%'`); sql(`delete from memberships where id in ('${M.a1}','${M.a2}','${M.a3}')`);
  sql(`delete from products where id='${P.pass}'`); sql(`delete from service_categories where label in (${CATS.map((c) => `'${c}'`).join(",")})`);
  sql(`update profiles set name='자녀A' where id='${ID.pA2}'`);
}

