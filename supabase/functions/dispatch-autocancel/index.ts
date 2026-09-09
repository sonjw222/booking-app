// Supabase Edge Function: 최소 인원 미달 수업 자동 폐강 (수업 폐강 시간 기능화)
//
// add_autocancel_scheduler.sql이 등록한 pg_cron 작업("dispatch-autocancel")이 1분마다
// 이 함수를 호출한다(요청 본문 없음, service_role 키로 인증). 실제 로직은 전부
// run_autocancel_sweep() RPC(SQL, security definer)에 있다 — 이 함수는 그 RPC를
// service_role 권한으로 호출하는 얇은 래퍼다(send-web-push와 동일한 패턴).
//
// 필요한 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY(Edge Function에 기본 주입)
// 배포: `supabase functions deploy dispatch-autocancel`

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST만 지원합니다" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await admin.rpc("run_autocancel_sweep");

  if (error) return json({ error: error.message }, 500);
  return json(data ?? { classes_cancelled: 0, reservations_cancelled: 0 });
});
