"use client";

/*
  프로필 관리 화면
  - 한 계정 아래 여러 프로필(수강 주체)을 관리
  - 프로필 추가 / 삭제 (대표 프로필은 삭제 불가)
  - 관계를 강제하지 않고 자유 라벨(label)만 선택 입력
*/

import { useCallback, useEffect, useState } from "react";
import BottomNav from "../components/BottomNav";
import Loading from "../components/Loading";
import { ZoomableImage } from "../components/ImageViewer";
import DatePicker from "../components/DatePicker";
import {
  fetchProfiles, addProfile, deleteProfile, updateProfile, uploadAvatar, avatarPublicUrl,
  type ProfileRow, type ProfileEdit,
} from "../../lib/profiles";

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newBirth, setNewBirth] = useState("");
  const [busy, setBusy] = useState(false);
  // 프로필 수정 시트
  const [editing, setEditing] = useState<ProfileRow | null>(null);
  const [edit, setEdit] = useState<ProfileEdit | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  function openEdit(p: ProfileRow) {
    setEditing(p);
    setEdit({
      nickname: p.nickname ?? "", label: p.label ?? "", birthDate: p.birthDate ?? "",
      gender: p.gender ?? "", shoeSize: p.shoeSize ?? "", clothSize: p.clothSize ?? "", address: p.address ?? "", phone: p.phone ?? "",
      memo: p.memo ?? "", avatarUrl: p.avatarUrl ?? null,
    });
    setError(null);
  }

  async function handleAvatarPick(file: File) {
    if (!edit) return;
    setUploadingAvatar(true);
    try {
      const path = await uploadAvatar(file);
      setEdit({ ...edit, avatarUrl: path });
    } catch (e: any) { setError(e.message); }
    finally { setUploadingAvatar(false); }
  }

  async function handleSaveEdit() {
    if (!editing || !edit) return;
    setBusy(true);
    try {
      await updateProfile(editing.id, edit);
      setEditing(null); setEdit(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProfiles(await fetchProfiles());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd() {
    if (!newName.trim()) {
      setError("프로필 이름을 입력해주세요");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addProfile(newName.trim(), newLabel.trim(), newBirth);
      setNewName("");
      setNewLabel("");
      setNewBirth("");
      setAdding(false);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(p: ProfileRow) {
    if (!(await globalThis.appConfirm(`'${p.name}' 프로필을 삭제할까요? 예약·수강권 기록도 함께 사라져요.`))) return;
    setBusy(true);
    try {
      await deleteProfile(p.id);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell account-page-v2">
      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">프로필 관리</div>
        <div className="side" />
      </div>

      <div className="profiles-intro">
        한 계정으로 여러 명의 수업을 관리할 수 있어요.
        예약할 때 어떤 프로필로 신청할지 고르게 돼요.
      </div>

      {loading ? (
        <Loading />
      ) : (
        <>
          {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

          <div className="profile-list">
            {profiles.map((p) => (
              <div key={p.id} className="profile-item">
                <button className="profile-item-tap" onClick={() => openEdit(p)}>
                  {p.avatarUrl
                    ? <img className="profile-avatar-img" src={avatarPublicUrl(p.avatarUrl) ?? ""} alt="" />
                    : <div className="profile-avatar">{p.name?.[0] ?? "?"}</div>}
                  <div className="profile-item-info">
                    <div className="profile-item-name">
                      {p.name}
                      {p.isPrimary && <span className="primary-badge">대표</span>}
                    </div>
                    <div className="profile-item-sub">
                      {[p.label, p.shoeSize && `${p.shoeSize}mm`, p.birthDate].filter(Boolean).join(" · ") || "정보 입력하기"}
                    </div>
                  </div>
                  <span className="profile-edit-chevron">›</span>
                </button>
                {!p.isPrimary && (
                  <button className="profile-del" disabled={busy} onClick={() => handleDelete(p)}>
                    삭제
                  </button>
                )}
              </div>
            ))}
          </div>

          {adding ? (
            <div className="add-profile-form">
              <input className="input-field" placeholder="프로필 이름 (필수)" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <input className="input-field" placeholder="라벨 (선택) — 예: 오전반, 개인용" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
              <DatePicker value={newBirth} onChange={setNewBirth} label="생년월일 선택" />
              <div className="add-profile-actions">
                <button className="ghost-btn" onClick={() => { setAdding(false); setError(null); }}>취소</button>
                <button className="primary-btn" disabled={busy} onClick={handleAdd}>
                  {busy ? "추가 중..." : "추가하기"}
                </button>
              </div>
            </div>
          ) : (
            <button className="add-profile-btn" onClick={() => setAdding(true)}>
              + 프로필 추가
            </button>
          )}
        </>
      )}

      {/* 프로필 수정 시트 */}
      {editing && edit && (
        <div className="sheet-overlay" onClick={() => { setEditing(null); setEdit(null); }}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">프로필 수정</div>

            {/* 프로필 사진 */}
            <div className="avatar-edit">
              {edit.avatarUrl
                ? <ZoomableImage className="avatar-edit-img" src={avatarPublicUrl(edit.avatarUrl) ?? ""} />
                : <div className="avatar-edit-placeholder">{editing.name?.[0] ?? "?"}</div>}
              <label className="avatar-edit-btn">
                {uploadingAvatar ? "업로드 중..." : "사진 변경"}
                <input type="file" accept="image/*" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAvatarPick(f); }} />
              </label>
            </div>

            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>이름 (변경 불가)</div>
            <input className="input-field" value={editing.name} disabled style={{ opacity: 0.6 }} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>별명 (선택) — 커뮤니티에서 이름 대신 표시돼요</div>
            <input className="input-field" placeholder="예: 발레하는곰" value={edit.nickname} onChange={(e) => setEdit({ ...edit, nickname: e.target.value })} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>라벨 (선택)</div>
            <input className="input-field" placeholder="예: 오전반, 개인용" value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>생년월일 (선택)</div>
            <DatePicker value={edit.birthDate} onChange={(birthDate) => setEdit({ ...edit, birthDate })} label="생년월일 선택" />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>성별 (선택)</div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {[["male", "남"], ["female", "여"], ["other", "기타"]].map(([v, lbl]) => (
                <button key={v} className={`filter-chip ${edit.gender === v ? "on" : ""}`} onClick={() => setEdit({ ...edit, gender: edit.gender === v ? "" : v })}>{lbl}</button>
              ))}
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>발 사이즈 (선택) — 피겨화 등 대여용</div>
            <input className="input-field" inputMode="numeric" placeholder="예: 240" value={edit.shoeSize} onChange={(e) => setEdit({ ...edit, shoeSize: e.target.value })} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>옷 사이즈 (선택) — 대여복 등</div>
            <input className="input-field" placeholder="예: M, 95, 100" value={edit.clothSize} onChange={(e) => setEdit({ ...edit, clothSize: e.target.value })} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>주소 (선택)</div>
            <input className="input-field" placeholder="예: 서울 강남구 ..." value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>추가 연락처 (선택)</div>
            <input className="input-field" inputMode="tel" placeholder="예: 010-1234-5678" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>특이사항 메모 (선택)</div>
            <input className="input-field" placeholder="예: 무릎 부상 이력" value={edit.memo} onChange={(e) => setEdit({ ...edit, memo: e.target.value })} />

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => { setEditing(null); setEdit(null); }}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleSaveEdit}>{busy ? "저장 중..." : "저장"}</button>
            </div>
          </div>
        </div>
      )}
      <BottomNav />
    </div>
  );
}
