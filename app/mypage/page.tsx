"use client";

/*
  마이페이지 - Supabase 실연동
  - 프로필, 수강권(잔여횟수/유효기간 프로그레스바), 예약내역, 로그아웃
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../components/Loading";
import {
  fetchMyPage, fetchRepurchaseAvailability, logout, refundEligibility, requestRefund,
  classifyMembershipDisplay, type Profile, type Membership, type RepurchaseAvailability,
} from "../../lib/mypage";
import { replaceTabNavigation } from "../../lib/navState";
import UiIcon from "../components/UiIcon";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "예약확정",
  waitlisted: "대기중",
  cancelled: "취소됨",
  attended: "출석완료",
  no_show: "노쇼",
};

function daysLeft(dateStr: string | null): number | null {
  if (!dateStr) return null; // 기간 무제한
  const today = new Date();
  const exp = new Date(dateStr + "T23:59:59+09:00");
  return Math.ceil((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

// rolling_month 상품(add_rolling_month_product_expiry.sql)이 다음 달로 넘어가면서
// starts_at이 미래로 찍힌 경우 — 그날이 되기 전까지는 예약에 못 쓴다(예약 RPC들이
// 서버에서도 동일하게 막음, 이건 그 이유를 화면에 미리 알려주는 용도).
function notYetStarted(startsAt: string | null): boolean {
  if (!startsAt) return false;
  const today = new Date().toISOString().slice(0, 10);
  return startsAt > today;
}

export default function MyPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  // item 8 — 만료/소진된 수강권 카드의 "다시 구매하기"/"센터 문의하기" CTA 우선순위를
  // 정하려면 그 센터/상품이 지금도 유효한지 알아야 한다(lib/mypage.ts 주석 참고). 활성
  // 수강권만 있는 대다수 사용자는 이 조회 자체가 안 붙도록 별도 state/effect로 분리.
  const [repurchase, setRepurchase] = useState<Record<string, RepurchaseAvailability>>({});
  const [showAllPasses, setShowAllPasses] = useState(false);
  const [showAllGoods, setShowAllGoods] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 환불 불가 사유 안내용 — 이 화면의 error 상태는 전체 화면을 에러 뷰로 바꾸는 용도라
  // (아래 `if (error) return ...`) 이런 짧은 알림에는 안 맞는다.
  const [toast, setToast] = useState<string | null>(null);
  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMyPage();
      setProfile(data.profile);
      setMemberships(data.memberships);
    } catch (e: any) {
      setError(e.message ?? "불러오지 못했어요");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const expiredPasses = memberships.filter((m) => {
      const { isExpired, isExhausted } = classifyMembershipDisplay(m);
      return m.kind === "pass" && (isExpired || isExhausted);
    });
    if (expiredPasses.length === 0) return;
    let mounted = true;
    fetchRepurchaseAvailability(expiredPasses)
      .then((v) => { if (mounted) setRepurchase(v); })
      .catch(() => { /* 조회 실패해도 CTA만 안 뜨고(3순위로 안전하게 폴백) 화면 자체는 그대로 */ });
    return () => { mounted = false; };
  }, [memberships]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRefund(m: Membership) {
    const elig = refundEligibility(m);
    if (!elig.ok) { showToast(elig.reason); return; }
    if (!(await globalThis.appConfirm(`'${m.productName}'을(를) 환불할까요?\n(결제 24시간 이내·미사용만 가능)`))) return;
    try {
      await requestRefund(m.id);
      await load();
    } catch (e: any) { setError(e.message); }
  }

  if (loading) {
    return (
      <div className="app-shell">
        <Loading />
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-shell">
        <div className="holiday-notice" style={{ marginTop: 60 }}>
          <div className="holiday-chip"><span className="hc-dot" />{error}</div>
        </div>
        <div style={{ padding: 20 }}>
          <a className="primary-btn" href="/login">로그인하러 가기</a>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell mypage-shell">
      {toast && <div className="toast">{toast}</div>}
      <div className="profile-block">
        <div className="avatar">{profile?.name?.[0] ?? "?"}</div>
        <div>
          <div className="profile-name">{profile?.name} 님</div>
          <a className="profile-edit" href="/profiles">프로필 수정 ›</a>
        </div>
      </div>

      {/* ACL-005: 관리자 모드 진입은 active manager_centers 소속 여부로만 판단(profile.isManager).
          UX 감사(B-1) 지적대로 예전엔 "설정" 섹션 맨 아래에 있어 센터 운영자가 매일 써야 할
          진입점이 화면 최하단에 우연히 발견되는 구조였다 — 프로필 바로 아래로 끌어올림. */}
      {profile?.isManager && (
        <a className="list-row manager-mode-switch" href="/manager" onClick={(e) => replaceTabNavigation(e, "/manager")}>
          <div className="left"><span className="icon"><UiIcon name="building" /></span>관리자 모드로 전환</div>
          <span className="chevron">›</span>
        </a>
      )}

      {(() => {
        const passes = memberships.filter((m) => m.kind === "pass");
        const goods = memberships.filter((m) => m.kind === "goods");

        const renderCard = (m: Membership, isGoods: boolean) => {
          const { isExpired, isExhausted, isPending: pending } = classifyMembershipDisplay(m);
          const ended = !isGoods && (isExpired || isExhausted); // item 8 — 만료/소진(수강권만 해당, 상품은 기존 그대로)
          // item 8 — 만료/소진 카드는 progress bar도 "다 썼음"으로 보이게(횟수가 남아 있어도
          // 기간 만료면 pct가 그대로 높게 나와 "아직 쓸 수 있어 보이는" 착시가 생겼다).
          // 과하게 흐리게(회색 처리)는 하지 않는다 — 요청사항.
          const pct = ended ? 100 : m.totalCount > 0 ? (m.remainingCount / m.totalCount) * 100 : 0;
          const left = daysLeft(m.expiresAt);
          const avail = repurchase[m.id];
          const CardTag = ended ? "div" : "a";
          return (
            <CardTag key={m.id} className={`membership-card ${isGoods ? "goods" : ""}`} {...(ended ? {} : { href: `/reservation?center=${m.centerId}` })}>
              <div className="name">
                {m.profileName && <span className="profile-tag">{m.profileName}</span>}
                {m.centerName} · {m.productName}
              </div>
              <div className="count">
                {m.unlimited ? "무제한" : <>{m.remainingCount}회 <span>/ {m.totalCount}회 남음</span></>}
              </div>
              {!m.unlimited && (
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${pct}%` }} />
                </div>
              )}
              <div className="expire">
                {pending
                  ? <span className="is-error-text">{m.startsAt}부터 사용 가능해요</span>
                  : left == null
                    ? "기간 무제한"
                    : <>{m.expiresAt}까지 · {left > 0 ? `${left}일 남음` : <span className="is-error-text">만료됨</span>}</>}
              </div>
              {/* item 8 — 만료/소진된 수강권은 "이 수강권으로 예약하기"를 절대 보여주지 않는다
                  (서버가 어차피 거부하지만, 애초에 될 것처럼 보이는 CTA 자체가 혼란을 줌).
                  우선순위: 1) 같은 상품이 아직 판매 중이면 "다시 구매하기"(정확한 상품 결제로
                  바로 이동, 상품이 사라졌으면 센터 상세의 구매 가능 목록으로 폴백) 2) 상품은
                  없어졌지만 센터는 살아있으면 "센터 문의하기"(기존 1:1 문의 화면 재사용, 새
                  시스템 안 만듦) 3) 센터/상품 둘 다 없으면 CTA 없이 위 상태 텍스트만. */}
              {!isGoods && !pending && !ended && <div className="membership-cta">이 수강권으로 예약하기 ›</div>}
              {ended && avail?.productPurchasable && (
                <a className="membership-cta" href={m.productId ? `/checkout?center=${m.centerId}&product=${m.productId}` : `/center/${m.centerId}`}>
                  다시 구매하기 ›
                </a>
              )}
              {ended && !avail?.productPurchasable && avail?.centerActive && (
                <a className="membership-cta" href="/inquiries">센터 문의하기 ›</a>
              )}
              {refundEligibility(m).ok && (
                <button className="membership-refund" onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRefund(m); }}>
                  환불하기 (24시간 이내·미사용)
                </button>
              )}
            </CardTag>
          );
        };

        return (
          <>
            {/* 수강권 */}
            <div className="menu-section-label hist-label">
              수강권
              {passes.length > 2 && (
                <button className="hist-more-btn" onClick={() => setShowAllPasses((v) => !v)}>
                  {showAllPasses ? "접기" : "전체보기 ›"}
                </button>
              )}
            </div>
            {passes.length === 0 ? (
              <div className="daylist-empty" style={{ padding: "20px" }}>보유한 수강권이 없어요</div>
            ) : (
              (showAllPasses ? passes : passes.slice(0, 2)).map((m) => renderCard(m, false))
            )}

            {/* 상품 (있을 때만) */}
            {goods.length > 0 && (
              <>
                <div className="menu-section-label hist-label">
                  상품
                  {goods.length > 2 && (
                    <button className="hist-more-btn" onClick={() => setShowAllGoods((v) => !v)}>
                      {showAllGoods ? "접기" : "전체보기 ›"}
                    </button>
                  )}
                </div>
                {(showAllGoods ? goods : goods.slice(0, 2)).map((m) => renderCard(m, true))}
              </>
            )}
          </>
        );
      })()}

      <div className="menu-section-label">내 정보</div>
      {/* UX 감사(A-13) — /mypage/history는 /my-reservations로 기능이 이전된 뒤에도(주석 참고,
          app/my-reservations/page.tsx) 이 링크만 안 고쳐진 채 남아 있었다. */}
      <a className="list-row" href="/my-reservations" onClick={(e) => replaceTabNavigation(e, "/my-reservations")}>
        <div className="left"><span className="icon"><UiIcon name="list" /></span>예약 내역</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/purchases">
        <div className="left"><span className="icon"><UiIcon name="receipt" /></span>구매 내역</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/mypage/points">
        <div className="left"><span className="icon"><UiIcon name="star" /></span>포인트 내역</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/mypage/coupons">
        <div className="left"><span className="icon"><UiIcon name="card" /></span>내 쿠폰</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/profiles">
        <div className="left"><span className="icon"><UiIcon name="users" /></span>프로필 관리</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/mypage/info">
        <div className="left"><span className="icon"><UiIcon name="shield" /></span>내 정보 관리</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/inquiries">
        <div className="left"><span className="icon"><UiIcon name="message" /></span>1:1 문의</div>
        <span className="chevron">›</span>
      </a>

      <div className="menu-section-label">설정</div>
      <a className="list-row" href="/settings/theme"><div className="left"><span className="icon"><UiIcon name="palette" /></span>테마 설정</div><span className="chevron">›</span></a>
      <a className="list-row" href="/settings/notifications"><div className="left"><span className="icon"><UiIcon name="bell" /></span>알림 설정</div><span className="chevron">›</span></a>
      <a className="list-row" href="/legal"><div className="left"><span className="icon"><UiIcon name="info" /></span>약관 및 정책</div><span className="chevron">›</span></a>
      {profile?.isPlatformAdmin && (
        <a className="list-row" href="/admin" onClick={(e) => replaceTabNavigation(e, "/admin")}>
          <div className="left"><span className="icon"><UiIcon name="shield" /></span>운영자 설정</div>
          <span className="chevron">›</span>
        </a>
      )}
      {/* UI-003: 가입 유형·기존 관리자 여부와 무관하게 모든 로그인 사용자가 새 센터를
          등록할 수 있다(정책 B) — /login이 아니라 등록 폼으로 바로 이동한다. */}
      <a className="list-row" href="/mypage/register-center">
        <div className="left"><span className="icon"><UiIcon name="building" /></span>내 센터 등록하기</div>
        <span className="chevron">›</span>
      </a>
      {/* UX 감사(A-19) — 바로 위 "내 센터 등록하기"와 같은 행 스타일로 붙어있어 오탭 위험이
          있는데, 확인 없이 즉시 로그아웃+리다이렉트됐다. */}
      <button className="list-row logout-row" onClick={async () => { if (await globalThis.appConfirm("로그아웃할까요?")) logout(); }}>
        <div className="left"><span className="icon"><UiIcon name="logout" /></span>로그아웃</div>
      </button>
    </div>
  );
}
