"use client";

/*
  매니저 - 후기 관리
  - 자기 센터에 달린 후기 모아보기
  - 답변 작성/수정
  - 악성 후기 삭제
*/

import { useCallback, useEffect, useState } from "react";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchCenterReviewsForManager, fetchReviewStats, replyToReview, deleteReviewAsManager,
  reviewPhotoUrl, type ManagerReview, type ReviewStats,
} from "../../../lib/reviews";
import Loading from "../../components/Loading";
import ManagerNav from "../../components/ManagerNav";
import RichTextEditor from "../center-info/RichTextEditor";

export default function ManagerReviewsPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ManagerReview[]>([]);
  const [stats, setStats] = useState<ReviewStats>({ total: 0, avgRating: 0, noReply: 0 });
  const [filter, setFilter] = useState<"all" | "noreply">("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 답변 작성 (서식 지원: HTML)
  const [replyFor, setReplyFor] = useState<ManagerReview | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replyAlign, setReplyAlign] = useState<"left" | "center" | "right">("left");
  const [replyFontSize, setReplyFontSize] = useState(15);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        if (list.length > 0) setCenterId(list[0].id);
        else setLoading(false);
      } catch (e: any) { setError(e.message); setLoading(false); }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      const [rs, st] = await Promise.all([
        fetchCenterReviewsForManager(centerId),
        fetchReviewStats(centerId),
      ]);
      setReviews(rs); setStats(st);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);
  useEffect(() => { load(); }, [load]);

  function openReply(r: ManagerReview) {
    setReplyFor(r);
    setReplyText(r.reply ?? "");
    setReplyAlign("left");
    setReplyFontSize(15);
  }

  async function handleReply() {
    if (!replyFor) return;
    setBusy(true);
    try {
      // HTML 태그를 벗긴 실제 텍스트가 비었으면 삭제로 간주
      const plain = replyText.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
      const toSave = plain ? replyText : "";
      await replyToReview(replyFor.id, toSave);
      showToast(plain ? "답변을 등록했어요" : "답변을 삭제했어요");
      setReplyFor(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(r: ManagerReview) {
    if (!confirm(
      `이 후기를 삭제할까요?\n\n` +
      `작성자: ${r.writerName}\n` +
      `내용: ${r.content.slice(0, 40)}${r.content.length > 40 ? "…" : ""}\n\n` +
      `되돌릴 수 없어요. 부적절한 내용일 때만 삭제해주세요.`
    )) return;
    setBusy(true);
    try {
      await deleteReviewAsManager(r.id);
      showToast("후기를 삭제했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  const shown = filter === "noreply" ? reviews.filter((r) => !r.reply) : reviews;

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">후기 관리</div>
        <div className="side" />
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>{c.name}</button>
          ))}
        </div>
      )}

      {/* 요약 */}
      <div className="rv-stats">
        <div className="rv-stat">
          <span className="rv-stat-label">전체</span>
          <span className="rv-stat-value">{stats.total}</span>
        </div>
        <div className="rv-stat">
          <span className="rv-stat-label">평균 별점</span>
          <span className="rv-stat-value">
            {stats.avgRating > 0 ? `★ ${stats.avgRating}` : "-"}
          </span>
        </div>
        <div className="rv-stat">
          <span className="rv-stat-label">답변 대기</span>
          <span className="rv-stat-value warn">{stats.noReply}</span>
        </div>
      </div>

      <div className="mem-filters">
        <button className={`filter-chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>전체</button>
        <button className={`filter-chip ${filter === "noreply" ? "on" : ""}`} onClick={() => setFilter("noreply")}>
          답변 대기 {stats.noReply > 0 ? `(${stats.noReply})` : ""}
        </button>
      </div>

      {loading ? <Loading /> : shown.length === 0 ? (
        <div className="daylist-empty" style={{ padding: "50px 20px" }}>
          {filter === "noreply" ? "답변을 기다리는 후기가 없어요" : "아직 후기가 없어요"}
        </div>
      ) : (
        <div className="mgr-review-list">
          {shown.map((r) => (
            <div key={r.id} className="mgr-review">
              <div className="mgr-review-head">
                <span className="review-stars">
                  {"★".repeat(r.rating)}<span className="review-stars-off">{"★".repeat(5 - r.rating)}</span>
                </span>
                <span className="mgr-review-writer">{r.writerName}</span>
                <span className="review-date">{r.createdAt}</span>
              </div>

              <div className="review-content">{r.content}</div>

              {r.photos && r.photos.length > 0 && (
                <div className="review-photos">
                  {r.photos.map((ph, i) => (
                    <img key={i} className="review-photo" src={reviewPhotoUrl(ph) ?? ""} alt="" />
                  ))}
                </div>
              )}

              {r.reply && (
                <div className="review-reply">
                  <div className="review-reply-head">
                    센터 답변 {r.repliedAt && <span className="review-reply-date">{r.repliedAt}</span>}
                  </div>
                  <div className="review-reply-body" dangerouslySetInnerHTML={{ __html: r.reply }} />
                </div>
              )}

              <div className="review-actions">
                <button className="review-edit" disabled={busy} onClick={() => openReply(r)}>
                  {r.reply ? "답변 수정" : "답변 달기"}
                </button>
                <button className="review-del" disabled={busy} onClick={() => handleDelete(r)}>삭제</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 답변 시트 */}
      {replyFor && (
        <div className="sheet-overlay" onClick={() => setReplyFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">답변 {replyFor.reply ? "수정" : "달기"}</div>

            <div className="mgr-review-quote">
              <span className="review-stars">
                {"★".repeat(replyFor.rating)}<span className="review-stars-off">{"★".repeat(5 - replyFor.rating)}</span>
              </span>
              <div className="review-content" style={{ marginTop: 6 }}>{replyFor.content}</div>
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>답변 내용</div>
            <RichTextEditor
              html={replyText}
              align={replyAlign}
              fontSize={replyFontSize}
              onChangeHtml={setReplyText}
              onChangeAlign={setReplyAlign}
              onChangeFontSize={setReplyFontSize}
            />
            <div className="perm-guide" style={{ margin: "6px 0 0" }}>
              글자를 굵게·기울임·색상·크기로 꾸밀 수 있어요. 비우고 저장하면 기존 답변이 삭제돼요.
            </div>

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setReplyFor(null)}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleReply}>저장</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ height: 20 }} />
      <ManagerNav />
    </div>
  );
}
