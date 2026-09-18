"use client";

/*
  회원 - 내 쿠폰 (MWHABIT Membership Visibility + Member Coupon Batch, 2026-09-18)
  - fetchMyCoupons()가 "내 쿠폰 조회" RLS(member_coupons, center_member_id in 내 프로필들)로
    이미 걸러서 주므로 다른 회원 쿠폰은 애초에 응답에 안 온다 — 이 화면은 그 결과를
    그대로 보여줄 뿐.
  - 실제 사용 가능 여부(최소금액/적용 상품/구매 자격)는 구매 화면에서 다시 필터링되고,
    최종 할인금액은 결제 확정 시점에 서버가 재계산한다 — 여기 표시는 안내용.
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import EmptyState from "../../components/EmptyState";
import { fetchMyCoupons, type MemberCoupon } from "../../../lib/coupons";

const STATUS_LABEL: Record<string, string> = {
  available: "사용 가능", used: "사용 완료", expired: "만료됨", revoked: "회수됨",
};

function discountText(c: MemberCoupon): string {
  if (c.discountType === "fixed") return `${c.discountValue.toLocaleString("ko-KR")}원 할인`;
  return `${c.discountValue}% 할인${c.maxDiscountAmount ? ` (최대 ${c.maxDiscountAmount.toLocaleString("ko-KR")}원)` : ""}`;
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(new Date(d));
}

export default function MyCouponsPage() {
  const [coupons, setCoupons] = useState<MemberCoupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setCoupons(await fetchMyCoupons()); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const available = coupons.filter((c) => c.status === "available");
  const others = coupons.filter((c) => c.status !== "available");

  const renderCard = (c: MemberCoupon) => (
    <div key={c.id} className={`pass-card ${c.status !== "available" ? "goods" : ""}`}>
      <div className="pass-head">
        <div>
          <div className="pass-name">{c.couponName}</div>
          <div className="pass-sub">{discountText(c)}</div>
          {c.minimumOrderAmount != null && (
            <div className="pass-sub">{c.minimumOrderAmount.toLocaleString("ko-KR")}원 이상 구매 시 사용 가능</div>
          )}
          <div className="pass-sub">
            {STATUS_LABEL[c.status] ?? c.status}
            {c.validUntil && ` · ${fmtDate(c.validUntil)}까지`}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">내 쿠폰</div>
        <div className="side" />
      </div>

      {error && <div className="auth-msg error" style={{ margin: "8px 20px" }}>{error}</div>}

      {loading ? (
        <Loading />
      ) : coupons.length === 0 ? (
        <EmptyState icon="card" title="보유한 쿠폰이 없어요" description="센터에서 쿠폰을 지급하면 여기에 표시돼요." />
      ) : (
        <div className="pass-list">
          {available.length > 0 && (
            <>
              <div className="menu-section-label hist-label">사용 가능</div>
              {available.map(renderCard)}
            </>
          )}
          {others.length > 0 && (
            <>
              <div className="menu-section-label hist-label">지난 쿠폰</div>
              {others.map(renderCard)}
            </>
          )}
          <div style={{ height: 40 }} />
        </div>
      )}
    </div>
  );
}
