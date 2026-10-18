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
  classBookability, fetchCenterClassDetail, fetchUpcomingSessions, formatBookingDeadline, formatClassWhen, remainingSpots,
  type ClassDetail, type UpcomingSession,
} from "../../../../../lib/classDetail";
import { hasActivePassAtCenter } from "../../../../../lib/center";
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
  const [hasPass, setHasPass] = useState(false);
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
          const [s, p] = await Promise.allSettled([fetchUpcomingSessions(centerId, d.title, d.id), hasActivePassAtCenter(centerId)]);
          if (!alive) return;
          setSessions(s.status === "fulfilled" ? s.value : []);
          setHasPass(p.status === "fulfilled" ? p.value : false);
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
  const instructors = formatInstructorNames(detail.instructorNames);
  const canReserve = bookability === "open";
  const notice = bookability === "cancelled" ? "폐강된 수업이에요" : bookability === "past" ? "이미 시작했거나 지난 수업이에요" : bookability === "closed" ? "예약이 마감된 수업이에요" : null;
  const reserveHref = reservationReturnUrl({ classId: detail.id, date: detail.date, center: centerId });
  const buyHref = `${centerHref}?buy=1&reserveClassId=${encodeURIComponent(detail.id)}&reserveDate=${encodeURIComponent(detail.date)}&reserveCenter=${encodeURIComponent(centerId)}`;

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "종목", value: detail.centerCategories.length > 0 ? detail.centerCategories.join(" · ") : null },
    { label: "일정", value: formatClassWhen(detail.startIso, detail.endIso) },
    { label: "장소", value: detail.place },
    { label: "담당 강사", value: instructors },
    { label: "정원", value: `${detail.capacity}명${canReserve ? ` · ${spots > 0 ? `${spots}자리 남음` : "정원 마감(대기 가능)"}` : ""}` },
    { label: "예약 마감", value: deadline },
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
          <div className="class-detail-chips">
            {detail.passSelectionMode === "selected" && detail.allowedPassNames.length > 0
              ? detail.allowedPassNames.map((n) => <span key={n} className="class-pass-chip">{n}</span>)
              : <span className="class-pass-chip all">모든 수강권 가능</span>}
          </div>
          <p className="class-detail-hint">이 센터의 수강권으로 예약할 수 있어요. 예약 가능 여부는 예약할 때 다시 확인돼요.</p>
        </section>

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
        <Link className={`center-bar-btn buy ${hasPass ? "secondary" : "primary"}`} href={buyHref} prefetch={false}>수강권 구매하기</Link>
        {canReserve
          ? (hasPass
              ? <Link className="center-bar-btn reserve primary" href={reserveHref} prefetch={false}>예약하기</Link>
              : <button type="button" className="center-bar-btn reserve secondary" onClick={() => setNeedPassDialog(true)}>예약하기</button>)
          : <button type="button" className="center-bar-btn reserve secondary" disabled>예약하기</button>}
      </div>

      <ConfirmDialog
        open={needPassDialog}
        title="수강권이 필요해요"
        icon="ticket"
        description="이 센터의 수강권을 먼저 구매해주세요."
        confirmLabel="수강권 구매하기"
        cancelLabel="닫기"
        onCancel={() => setNeedPassDialog(false)}
        onConfirm={() => { setNeedPassDialog(false); router.push(buyHref); }}
      />
    </div>
  );
}
