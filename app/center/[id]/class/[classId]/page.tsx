"use client";

/*
  수업 상세 (센터 상세 > 수업 탭에서 수업을 눌렀을 때)
  - 별도 라우트라 딥링크 · 새로고침 · 브라우저 뒤로가기가 그대로 동작한다(뒤로가기 → 센터 상세의 수업 탭이 아닌 이전 화면 = 센터 상세).
  - 하단 CTA: [수강권 구매하기] [예약하기]. 기존 구매/예약 URL 계약을 그대로 쓴다.
      예약하기  → /reservation?openClassId=…&openDate=…&center=…  (예약 화면이 이 수업의 확인 모달을 정확히 연다)
      구매하기  → /center/[id]?buy=1&reserveClassId=…&reserveDate=…&reserveCenter=…  (구매 시트가 열리고, 구매 후 이 수업 예약으로 복귀)
    수강권이 없으면 예약하기는 안내 다이얼로그를 먼저 띄운다. 실제 예약 가능 여부(수강권·정원·마감)는 예약 시점에 서버가 다시 검증한다.
*/
import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  classBookability, fetchCenterClassDetail, fetchUpcomingSessions, formatBookingDeadline, formatCancelPolicy, formatClassWhen, remainingSpots,
  type ClassDetail, type UpcomingSession,
} from "../../../../../lib/classDetail";
import { BLOCKED_COPY, decideClassAction, fetchViewerClassState, type ViewerState } from "../../../../../lib/classViewer";
import { formatInstructorNames } from "../../../../../lib/instructorDisplay";
import { reservationReturnUrl } from "../../../../../lib/reservationNav";
import Loading from "../../../../components/Loading";
import ErrorState from "../../../../components/ErrorState";
import EmptyState from "../../../../components/EmptyState";
import BackButton from "../../../../components/BackButton";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import UiIcon from "../../../../components/UiIcon";

export default function ClassDetailPage() {
  const params = useParams();
  const router = useRouter();
  const centerId = String(params.id);
  const classId = String(params.classId);
  const [detail, setDetail] = useState<ClassDetail | null>(null);
  const [sessions, setSessions] = useState<UpcomingSession[]>([]);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [needPassDialog, setNeedPassDialog] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await fetchCenterClassDetail(centerId, classId);
        if (!alive) return;
        setDetail(d);
        if (d) {
          // 보조 정보 — 실패해도 상세는 보여준다.
          const [s, v] = await Promise.allSettled([fetchUpcomingSessions(centerId, d.title, d.id), fetchViewerClassState(centerId, d.id)]);
          if (!alive) return;
          setSessions(s.status === "fulfilled" ? s.value : []);
          const state = v.status === "fulfilled" ? v.value : ({ kind: "error" } as ViewerState);
          setViewer(state);
          // 기본 프로필: 사용 가능한 수강권이 있는 첫 프로필(대표 프로필 우선), 없으면 대표 프로필.
          if (state.kind === "member") setProfileId((state.profiles.find((p) => p.status === "usable") ?? state.profiles[0])?.profile.id ?? null);
        }
      } catch { if (alive) setError(true); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [centerId, classId, reloadKey]);
  const retry = () => { setError(false); setLoading(true); setReloadKey((k) => k + 1); };

  const centerHref = `/center/${centerId}`;
  const header = (
    <div className="back-header">
      <BackButton fallbackHref={centerHref} />
      <div className="title">수업 상세</div>
      <div className="side" />
    </div>
  );

  if (loading) return <div className="app-shell center-detail-v2 class-detail-v2">{header}<Loading /></div>;
  if (error) return (
    <div className="app-shell center-detail-v2 class-detail-v2">{header}
      <ErrorState title="수업 정보를 불러오지 못했어요" description="연결 상태를 확인하고 다시 시도해 주세요."
        action={<button type="button" className="primary-btn" onClick={retry}>다시 시도</button>} />
    </div>
  );
  if (!detail) return (
    <div className="app-shell center-detail-v2 class-detail-v2">{header}
      <EmptyState icon="calendar" title="수업을 찾을 수 없어요" description="종료되었거나 삭제된 수업일 수 있어요."
        action={<Link className="primary-btn" href={centerHref} prefetch={false}>센터로 돌아가기</Link>} />
    </div>
  );

  const bookability = classBookability(detail);
  const spots = remainingSpots(detail.capacity, detail.reserved);
  const deadline = formatBookingDeadline(detail.bookingDeadlineMin);
  // 강사: 조회가 막히거나 실패한 경우 "강사 없음"으로 보이지 않게 이유를 말한다(없음이 확인된 경우에만 행을 만들지 않는다).
  const instructors = detail.trainers.kind === "list" ? formatInstructorNames(detail.trainers.names)
    : detail.trainers.kind === "login_required" ? "로그인 후 확인할 수 있어요"
    : detail.trainers.kind === "unavailable" ? "불러오지 못했어요" : null;
  const canReserve = bookability === "open";
  const notice = bookability === "cancelled" ? "폐강된 수업이에요" : bookability === "past" ? "이미 시작했거나 지난 수업이에요" : bookability === "closed" ? "예약이 마감된 수업이에요" : null;
  const members = viewer?.kind === "member" ? viewer.profiles : [];
  const action = decideClassAction(bookability, viewer, profileId);
  const curProfile = members.find((p) => p.profile.id === profileId) ?? members[0] ?? null;
  const reserveBase = reservationReturnUrl({ classId: detail.id, date: detail.date, center: centerId });
  const reserveHref = members.length > 1 && curProfile ? `${reserveBase}&profile=${encodeURIComponent(curProfile.profile.id)}` : reserveBase;
  // 이 수업에 쓸 수 있는 상품만 먼저 보여 달라고 센터 구매 시트에 넘긴다(지정 수강권 수업일 때). 전체 보기는 시트 안에서 가능.
  const allowedIds = detail.allowedPasses.kind === "list" ? detail.allowedPasses.productIds : [];
  const buyHref = `${centerHref}?buy=1&reserveClassId=${encodeURIComponent(detail.id)}&reserveDate=${encodeURIComponent(detail.date)}&reserveCenter=${encodeURIComponent(centerId)}${allowedIds.length > 0 ? `&productIds=${allowedIds.map(encodeURIComponent).join(",")}` : ""}`;
  const loginHref = `/login?next=${encodeURIComponent(`${centerHref}/class/${detail.id}`)}`;
  const blocked = action.kind === "blocked" ? BLOCKED_COPY[action.reason] : null;
  const allowedNote = detail.allowedPasses.kind === "list" ? ` 이 수업에 쓸 수 있는 수강권: ${detail.allowedPasses.names.join(", ")}.` : "";

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "종목", value: detail.centerCategories.length > 0 ? detail.centerCategories.join(" · ") : null },
    { label: "일정", value: formatClassWhen(detail.startIso, detail.endIso) },
    { label: "장소", value: detail.place },
    { label: "담당 강사", value: instructors },
    { label: "정원", value: `${detail.capacity}명${canReserve && detail.reservedKnown ? ` · ${spots > 0 ? `${spots}자리 남음` : "정원 마감(대기 가능)"}` : ""}` },
    { label: "예약 마감", value: deadline },
    { label: "취소 조건", value: formatCancelPolicy(detail) },
  ].filter((r) => r.value);

  return (
    <div className="app-shell center-detail-v2 class-detail-v2">
      {header}
      <main className="class-detail-main">
        <div className="class-detail-hero">
          <Link className="class-detail-center" href={centerHref} prefetch={false}>{detail.centerName} <span aria-hidden="true">›</span></Link>
          <h1>{detail.title}</h1>
          {detail.classFormat === "private" && <span className="class-detail-badge">프라이빗 1:1</span>}
        </div>

        {notice && <p className="class-detail-notice" role="status"><UiIcon name="info" size={16} />{notice}</p>}

        <dl className="class-detail-facts">
          {rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
        </dl>

        {detail.description && (
          <section className="class-detail-section" aria-labelledby="cd-desc">
            <h2 id="cd-desc">수업 소개</h2>
            <p className="class-detail-desc">{detail.description}</p>
          </section>
        )}

        <section className="class-detail-section" aria-labelledby="cd-cond">
          <h2 id="cd-cond">참여 조건</h2>
          {/* "모든 수강권 가능"은 수업이 실제로 all 모드일 때만. 지정(selected) 수업의 목록을 읽을 수 없으면(비로그인 RLS, 조회 실패, 빈 결과) 절대 모두 가능이라고 말하지 않는다. */}
          {detail.allowedPasses.kind === "all" && <div className="class-detail-chips"><span className="class-pass-chip all">모든 수강권 가능</span></div>}
          {detail.allowedPasses.kind === "list" && <div className="class-detail-chips">{detail.allowedPasses.names.map((n) => <span key={n} className="class-pass-chip">{n}</span>)}</div>}
          {detail.allowedPasses.kind === "login_required" && <p className="class-detail-hint" data-testid="allowed-passes-note">이용 가능한 수강권은 로그인 후 확인해 주세요.</p>}
          {detail.allowedPasses.kind === "unavailable" && <p className="class-detail-hint" data-testid="allowed-passes-note">이용 가능한 수강권 정보를 불러오지 못했어요. 예약할 때 다시 확인돼요.</p>}
          {detail.allowedPasses.kind === "unknown_empty" && <p className="class-detail-hint" data-testid="allowed-passes-note">이 수업에 지정된 수강권을 확인할 수 없어요. 예약할 때 확인돼요.</p>}
          <p className="class-detail-hint">예약 가능 여부(수강권·정원·마감)는 예약할 때 서버에서 다시 확인돼요.</p>
        </section>

        {/* 내 수강권 — 수업 정보(공개)와 별개로, 로그인 회원에게만 이 수업을 쓸 수 있는지 알려준다. */}
        {viewer?.kind === "anon" && (
          <section className="class-detail-section" aria-labelledby="cd-me">
            <h2 id="cd-me">예약하려면</h2>
            <p className="class-detail-hint" data-testid="viewer-note">로그인하면 내 수강권으로 이 수업을 예약할 수 있어요. 수업 내용은 로그인 없이 볼 수 있어요.</p>
          </section>
        )}
        {members.length > 0 && curProfile && (
          <section className="class-detail-section" aria-labelledby="cd-me">
            <h2 id="cd-me">내 수강권</h2>
            {members.length > 1 && (
              <div className="class-detail-chips" role="group" aria-label="예약할 프로필">
                {members.map((p) => (
                  <button key={p.profile.id} type="button" aria-pressed={p.profile.id === curProfile.profile.id}
                    className={`class-pass-chip ${p.profile.id === curProfile.profile.id ? "all" : ""}`} onClick={() => setProfileId(p.profile.id)}>
                    {p.profile.name}{p.profile.label ? ` · ${p.profile.label}` : ""}
                  </button>
                ))}
              </div>
            )}
            {curProfile.status === "usable" ? (
              <ul className="class-detail-sessions" data-testid="usable-passes">
                {curProfile.usable.map((m) => (
                  <li key={m.membershipId}><span>{m.productName}</span><b>{m.remainingCount == null ? "횟수 무제한" : `${m.remainingCount}회 남음`}{m.expiresAt ? ` · ~${m.expiresAt.slice(5).replace("-", "/")}` : " · 기간 무제한"}</b></li>
                ))}
              </ul>
            ) : (
              <p className="class-detail-hint" data-testid="viewer-note">{BLOCKED_COPY[curProfile.status as keyof typeof BLOCKED_COPY].description}</p>
            )}
          </section>
        )}

        {sessions.length > 0 && (
          <section className="class-detail-section" aria-labelledby="cd-more">
            <h2 id="cd-more">같은 수업의 다른 일정</h2>
            <ul className="class-detail-sessions">
              {sessions.map((s) => (
                <li key={s.id}><Link href={`${centerHref}/class/${s.id}`} prefetch={false}>
                  <span>{s.whenText}</span><b>{s.reserved >= s.capacity ? "대기" : `${s.reserved}/${s.capacity}`}</b>
                </Link></li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <div className="center-bottom-bar class-detail-bar">
        {action.kind === "reserve" || action.kind === "check_at_reserve" ? (
          <>
            <Link className="center-bar-btn buy secondary" href={buyHref} prefetch={false}>수강권 구매하기</Link>
            <Link className="center-bar-btn reserve primary" href={reserveHref} prefetch={false}>예약하기</Link>
          </>
        ) : action.kind === "login" ? (
          <>
            <Link className="center-bar-btn buy secondary" href={buyHref} prefetch={false}>수강권 보기</Link>
            <Link className="center-bar-btn reserve primary" href={loginHref} prefetch={false}>로그인하고 예약</Link>
          </>
        ) : action.kind === "blocked" ? (
          <>
            <Link className="center-bar-btn buy primary" href={buyHref} prefetch={false}>사용 가능한 수강권 보기</Link>
            <button type="button" className="center-bar-btn reserve secondary" onClick={() => setNeedPassDialog(true)}>예약하기</button>
          </>
        ) : (
          <>
            <Link className="center-bar-btn buy secondary" href={buyHref} prefetch={false}>수강권 구매하기</Link>
            <button type="button" className="center-bar-btn reserve secondary" disabled>예약하기</button>
          </>
        )}
      </div>

      <ConfirmDialog
        open={needPassDialog && !!blocked}
        title={blocked?.title ?? ""}
        icon="ticket"
        description={`${blocked?.description ?? ""}${allowedNote}`}
        confirmLabel="사용 가능한 수강권 보기"
        cancelLabel="닫기"
        onCancel={() => setNeedPassDialog(false)}
        onConfirm={() => { setNeedPassDialog(false); router.push(buyHref); }}
      />
    </div>
  );
}
