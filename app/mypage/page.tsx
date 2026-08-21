"use client";

/*
  마이페이지 - Supabase 실연동
  - 프로필, 수강권(잔여횟수/유효기간 프로그레스바), 예약내역, 로그아웃
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../components/Loading";
import { fetchMyPage, logout, refundEligibility, requestRefund, type Profile, type Membership, type HistoryItem } from "../../lib/mypage";
import UiIcon from "../components/UiIcon";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "예약확정",
  waitlisted: "대기중",
  cancelled: "취소됨",
  attended: "출석완료",
  no_show: "노쇼",
};

function daysLeft(dateStr: string) {
  const today = new Date();
  const exp = new Date(dateStr + "T23:59:59+09:00");
  return Math.ceil((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export default function MyPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [showAllPasses, setShowAllPasses] = useState(false);
  const [showAllGoods, setShowAllGoods] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMyPage();
      setProfile(data.profile);
      setMemberships(data.memberships);
      setHistory(data.history);
    } catch (e: any) {
      setError(e.message ?? "불러오지 못했어요");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRefund(m: Membership) {
    const elig = refundEligibility(m);
    if (!elig.ok) { alert(elig.reason); return; }
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
      <div className="profile-block">
        <div className="avatar">{profile?.name?.[0] ?? "?"}</div>
        <div>
          <div className="profile-name">{profile?.name} 님</div>
          <a className="profile-edit" href="/profiles">프로필 수정 ›</a>
        </div>
      </div>

      {(() => {
        const passes = memberships.filter((m) => m.kind === "pass");
        const goods = memberships.filter((m) => m.kind === "goods");

        const renderCard = (m: Membership, isGoods: boolean) => {
          const pct = m.totalCount > 0 ? (m.remainingCount / m.totalCount) * 100 : 0;
          const left = daysLeft(m.expiresAt);
          return (
            <a key={m.id} className={`membership-card ${isGoods ? "goods" : ""}`} href={`/reservation?center=${m.centerId}`}>
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
                {m.expiresAt}까지 · {left > 0 ? `${left}일 남음` : "만료됨"}
              </div>
              {!isGoods && <div className="membership-cta">이 수강권으로 예약하기 ›</div>}
              {refundEligibility(m).ok && (
                <button className="membership-refund" onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRefund(m); }}>
                  환불하기 (24시간 이내·미사용)
                </button>
              )}
            </a>
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
      <a className="list-row" href="/purchases">
        <div className="left"><span className="icon"><UiIcon name="receipt" /></span>구매 내역</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/mypage/points">
        <div className="left"><span className="icon"><UiIcon name="star" /></span>포인트 내역</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/profiles">
        <div className="left"><span className="icon"><UiIcon name="users" /></span>프로필 관리</div>
        <span className="chevron">›</span>
      </a>
      <a className="list-row" href="/inquiries">
        <div className="left"><span className="icon"><UiIcon name="message" /></span>1:1 문의</div>
        <span className="chevron">›</span>
      </a>

      <div className="menu-section-label">설정</div>
      <a className="list-row" href="/settings/theme"><div className="left"><span className="icon"><UiIcon name="palette" /></span>테마 설정</div><span className="chevron">›</span></a>
      <a className="list-row" href="/settings/notifications"><div className="left"><span className="icon"><UiIcon name="bell" /></span>알림 설정</div><span className="chevron">›</span></a>
      <a className="list-row" href="/settings/account"><div className="left"><span className="icon"><UiIcon name="shield" /></span>계정 설정</div><span className="chevron">›</span></a>
      {profile?.isPlatformAdmin && (
        <a className="list-row" href="/admin">
          <div className="left"><span className="icon"><UiIcon name="shield" /></span>운영자 설정</div>
          <span className="chevron">›</span>
        </a>
      )}
      {/* ACL-005: 관리자 모드 진입은 active manager_centers 소속 여부로만 판단(profile.isManager) —
          아래 "내 센터 등록하기"와 표시 조건이 서로 독립적이라 동시에 나타날 수 있다. */}
      {profile?.isManager && (
        <a className="list-row" href="/manager">
          <div className="left"><span className="icon"><UiIcon name="building" /></span>관리자 모드로 전환</div>
          <span className="chevron">›</span>
        </a>
      )}
      {/* UI-003: 가입 유형·기존 관리자 여부와 무관하게 모든 로그인 사용자가 새 센터를
          등록할 수 있다(정책 B) — /login이 아니라 등록 폼으로 바로 이동한다. */}
      <a className="list-row" href="/mypage/register-center">
        <div className="left"><span className="icon"><UiIcon name="building" /></span>내 센터 등록하기</div>
        <span className="chevron">›</span>
      </a>
      <button className="list-row logout-row" onClick={logout}>
        <div className="left"><span className="icon"><UiIcon name="logout" /></span>로그아웃</div>
      </button>
    </div>
  );
}
