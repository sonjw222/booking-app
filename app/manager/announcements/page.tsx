"use client";

/*
  매니저 - 공지사항
  - 자기 센터 공지 작성 (제목 + 서식 본문 + 사진)
  - 목록 / 수정 / 삭제
  - 작성 시 관계된 회원 전원에게 알림 발송 (create_announcement RPC)
*/

import { useCallback, useEffect, useState } from "react";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchCenterAnnouncements, createAnnouncement, updateAnnouncement,
  deleteAnnouncement, uploadAnnouncementPhoto, announcementPhotoUrl,
  type Announcement,
} from "../../../lib/announcements";
import Loading from "../../components/Loading";
import ManagerNav from "../../components/ManagerNav";
import RichTextEditor from "../../components/RichTextEditor";

export default function ManagerAnnouncementsPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [list, setList] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 작성/수정 시트
  const [sheet, setSheet] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [align, setAlign] = useState<"left" | "center" | "right">("left");
  const [fontSize, setFontSize] = useState(15);
  const [photos, setPhotos] = useState<string[]>([]);
  const [pinned, setPinned] = useState(false);
  const [uploading, setUploading] = useState(false);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cs = await fetchMyCenters();
      setCenters(cs);
      const cid = centerId ?? cs[0]?.id ?? null;
      setCenterId(cid);
      if (cid) setList(await fetchCenterAnnouncements(cid));
    } catch (e: any) {
      setError(e.message ?? "불러오지 못했어요");
    } finally {
      setLoading(false);
    }
  }, [centerId]);
  useEffect(() => { load(); }, [load]);

  async function reloadList(cid: string) {
    try { setList(await fetchCenterAnnouncements(cid)); } catch { /* 무시 */ }
  }

  function openNew() {
    setEditingId(null);
    setTitle(""); setBody(""); setAlign("left"); setFontSize(15);
    setPhotos([]); setPinned(false);
    setSheet(true);
  }

  function openEdit(a: Announcement) {
    setEditingId(a.id);
    setTitle(a.title); setBody(a.body); setAlign("left"); setFontSize(15);
    setPhotos(a.photos ?? []); setPinned(a.pinned);
    setSheet(true);
  }

  async function handleSave() {
    if (!centerId) return;
    if (!title.trim()) { setError("제목을 입력해주세요"); return; }
    const plain = body.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
    if (!plain && photos.length === 0) { setError("내용이나 사진을 넣어주세요"); return; }
    setBusy(true); setError(null);
    try {
      if (editingId) {
        await updateAnnouncement(editingId, title.trim(), body, photos, pinned);
        showToast("공지를 수정했어요");
      } else {
        await createAnnouncement(centerId, title.trim(), body, photos, pinned);
        showToast("공지를 등록하고 회원에게 알렸어요");
      }
      setSheet(false);
      await reloadList(centerId);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm("이 공지를 삭제할까요?")) return;
    setBusy(true);
    try {
      await deleteAnnouncement(id);
      showToast("공지를 삭제했어요");
      if (centerId) await reloadList(centerId);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handlePhotoPick(file: File) {
    setUploading(true);
    try {
      const path = await uploadAnnouncementPhoto(file);
      setPhotos((prev) => [...prev, path]);
    } catch (e: any) { setError(e.message); }
    finally { setUploading(false); }
  }

  if (loading) return <Loading />;

  return (
    <div className="app-shell">
      <div className="header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="title" style={{ fontSize: 20, fontWeight: 800 }}>공지사항</div>
        <button className="primary-btn" style={{ width: "auto", padding: "8px 14px", fontSize: 13 }} onClick={openNew}>
          + 새 공지
        </button>
      </div>

      {centers.length > 1 && (
        <div className="chip-row" style={{ padding: "0 20px 10px", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {centers.map((c) => (
            <button key={c.id}
              className={`filter-chip ${c.id === centerId ? "on" : ""}`}
              onClick={async () => { setCenterId(c.id); await reloadList(c.id); }}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {error && <div className="auth-msg error" style={{ margin: "0 20px 10px" }}>{error}</div>}

      {list.length === 0 ? (
        <div className="empty-note" style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-dim)" }}>
          아직 공지가 없어요. 첫 공지를 올려보세요!
        </div>
      ) : (
        <div className="announce-list" style={{ padding: "0 20px" }}>
          {list.map((a) => (
            <div key={a.id} className="announce-item">
              <div className="announce-head">
                {a.pinned && <span className="announce-pin">고정</span>}
                <span className="announce-title">{a.title}</span>
                <span className="announce-date">{a.createdAt}</span>
              </div>
              <div className="announce-body" dangerouslySetInnerHTML={{ __html: a.body }} />
              {a.photos && a.photos.length > 0 && (
                <div className="review-photos">
                  {a.photos.map((ph, i) => (
                    <img key={i} className="review-photo" src={announcementPhotoUrl(ph) ?? ""} alt="" />
                  ))}
                </div>
              )}
              <div className="review-actions">
                <button className="review-edit" disabled={busy} onClick={() => openEdit(a)}>수정</button>
                <button className="review-del" disabled={busy} onClick={() => handleDelete(a.id)}>삭제</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 작성/수정 시트 */}
      {sheet && (
        <div className="sheet-overlay" onClick={() => setSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{editingId ? "공지 수정" : "새 공지"}</div>

            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>제목</div>
            <input className="input-field" placeholder="공지 제목"
              value={title} onChange={(e) => setTitle(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>내용</div>
            <RichTextEditor
              html={body} align={align} fontSize={fontSize}
              onChangeHtml={setBody} onChangeAlign={setAlign} onChangeFontSize={setFontSize}
            />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>사진 (선택, 여러 장)</div>
            <div className="rv-photo-add">
              {photos.map((ph, i) => (
                <div key={i} className="rv-photo-thumb">
                  <img src={announcementPhotoUrl(ph) ?? ""} alt="" />
                  <button className="rv-photo-del" onClick={() => setPhotos((prev) => prev.filter((_, x) => x !== i))}>×</button>
                </div>
              ))}
              <label className="rv-photo-btn">
                {uploading ? "…" : "+"}
                <input type="file" accept="image/*" hidden onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  await handlePhotoPick(f);
                  e.target.value = "";
                }} />
              </label>
            </div>

            <label className="announce-pin-toggle" style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 0", fontSize: 13.5 }}>
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              상단에 고정
            </label>

            <div className="add-profile-actions" style={{ marginTop: 16 }}>
              <button className="ghost-btn" onClick={() => setSheet(false)}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleSave}>
                {busy ? "저장 중..." : (editingId ? "수정" : "등록하고 알림 보내기")}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
      <div style={{ height: 20 }} />
      <ManagerNav />
    </div>
  );
}
