import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@supabase/supabase-js";

// 센터 플랫폼 구독료의 상품 소개 페이지. NICEPAY 심사 담당자와 실제 센터 오너가
// 동일한 활성 상품명·가격·이용조건을 확인한다. 결제·카드등록·권한 상승은 하지 않는다.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "센터 운영자용 월 구독 상품",
  description: "모하빗 센터 운영자용 월 구독 상품의 가격, 제공 기능, 자동 갱신 및 해지·환불 기준 안내",
  alternates: { canonical: "/center-subscription" },
};

type Plan = {
  id: string;
  name: string;
  monthly_price: number;
  description: string | null;
};

async function activePlans(): Promise<{ plans: Plan[]; error: boolean }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return { plans: [], error: true };
  try {
    // 운영에 이미 적용된 subscription_plans 공개 SELECT 정책만 사용한다.
    // service_role 키, 사용자 세션, 센터 구독 행, 빌링키에 접근하지 않는다.
    const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase
      .from("subscription_plans")
      .select("id,name,monthly_price,description")
      .eq("is_active", true)
      .order("created_at", { ascending: true });
    if (error) return { plans: [], error: true };
    const plans = (data ?? []).filter(
      (p): p is Plan => typeof p.id === "string" && typeof p.name === "string" &&
        Number.isSafeInteger(p.monthly_price) && p.monthly_price > 0 &&
        (p.description === null || typeof p.description === "string")
    );
    return { plans, error: false };
  } catch {
    return { plans: [], error: true };
  }
}

const detailItem = { padding: "7px 0", lineHeight: 1.75 } as const;
const detailKey = { color: "var(--ink)", fontWeight: 700 } as const;

export default async function CenterSubscriptionInformationPage() {
  const { plans, error } = await activePlans();
  return (
    <main className="app-shell">
      <div className="back-header">
        <Link className="side" href="/" prefetch={false} aria-label="홈으로">‹</Link>
        <div className="title">센터 구독 상품</div>
        <div className="side" />
      </div>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 20px 100px" }}>
        <header style={{ marginBottom: 24 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "var(--accent)", marginBottom: 7 }}>센터 운영자용 서비스</p>
          <h1 style={{ fontSize: 24, lineHeight: 1.4, color: "var(--ink)", margin: "0 0 10px" }}>모하빗 월 구독 상품 안내</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 14, lineHeight: 1.75, margin: 0 }}>
            이 상품은 센터 운영자가 모하빗의 회원·수업·예약 관리 기능을 이용하기 위한 플랫폼 월 이용권입니다.
            일반 회원이 각 센터에서 구매하는 수강권·상품과는 별개입니다.
          </p>
        </header>

        {error ? (
          <p role="alert" style={{ padding: 20, border: "1px solid var(--line)", borderRadius: 14 }}>
            구독 상품 정보를 일시적으로 확인할 수 없습니다. 잠시 후 다시 확인해주세요.
          </p>
        ) : plans.length === 0 ? (
          <p style={{ padding: 20, border: "1px solid var(--line)", borderRadius: 14 }}>
            현재 안내 가능한 월 구독 상품이 없습니다.
          </p>
        ) : plans.map((plan) => (
          <section key={plan.id} aria-label={plan.name} style={{
            border: "1px solid var(--line)", borderRadius: 16, background: "var(--card-bg)",
            padding: "22px 20px", marginBottom: 18
          }}>
            <h2 style={{ fontSize: 20, margin: "0 0 8px", color: "var(--ink)" }}>{plan.name}</h2>
            <p style={{ fontSize: 27, fontWeight: 800, margin: "0 0 4px", color: "var(--accent)" }}>
              월 {plan.monthly_price.toLocaleString("ko-KR")}원
            </p>
            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 18px" }}>부가세 포함 · 신용카드 월 정기결제 상품</p>
            {plan.description && (
              <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--ink)", margin: "0 0 12px" }}>{plan.description}</p>
            )}
            <ul style={{ padding: 0, margin: "0 0 18px", listStyle: "none", fontSize: 14, color: "var(--text-dim)" }}>
              <li style={detailItem}><strong style={detailKey}>서비스 제공기간</strong> — 1회 결제당 1개월</li>
              <li style={detailItem}><strong style={detailKey}>갱신·결제 주기</strong> — 최초 등록 후 매월 자동 갱신·청구 예정</li>
              <li style={detailItem}><strong style={detailKey}>제공 서비스</strong> — 센터 회원, 수업, 예약, 수강권 관리 등 매니저 기능</li>
              <li style={detailItem}><strong style={detailKey}>해지 방법</strong> — 센터 오너의 플랫폼 구독 화면에서 신청</li>
              <li style={detailItem}><strong style={detailKey}>해지 후 이용</strong> — 이미 결제한 이용기간 종료까지 이용 가능, 다음 결제일부터 청구 중단</li>
            </ul>
            <button type="button" disabled style={{
              width: "100%", minHeight: 48, borderRadius: 12, border: "1px solid var(--line)",
              color: "var(--text-dim)", background: "var(--surface)", fontSize: 14, fontWeight: 700
            }}>
              정기결제 카드 등록 준비 중
            </button>
            <p style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.7, margin: "10px 0 0" }}>
              현재 카드사 계약 및 정기결제 연동 준비 단계입니다. 이 화면에서는 카드정보를 입력받거나 결제를 승인하지 않습니다.
            </p>
          </section>
        ))}

        <section style={{ padding: "16px 2px", fontSize: 14, lineHeight: 1.9 }}>
          <h2 style={{ fontSize: 17, margin: "0 0 8px", color: "var(--ink)" }}>구독·해지 및 환불 안내</h2>
          <p style={{ color: "var(--text-dim)", margin: "0 0 10px" }}>
            센터 오너는 로그인 후 플랫폼 구독 화면에서 구독 상태와 결제수단을 관리할 수 있습니다.
            정기결제 활성화 전에는 카드등록이나 실제 청구가 진행되지 않습니다.
          </p>
          <p style={{ margin: 0 }}>
            <Link href="/legal/refund">해지·환불 정책 보기</Link>
            {" · "}
            <Link href="/legal/terms">이용약관 보기</Link>
            {" · "}
            <Link href="/legal/privacy">개인정보처리방침 보기</Link>
          </p>
          <p style={{ marginTop: 14 }}>
            <Link href="/manager/subscription" prefetch={false}>센터 오너 구독 관리 화면</Link>
            <span style={{ display: "block", fontSize: 12, color: "var(--text-dim)" }}>
              실제 센터 소유주 계정으로 로그인해야 접근할 수 있습니다.
            </span>
          </p>
        </section>
      </div>
    </main>
  );
}
