"use client";

/*
  매니저 - 룸(장소) 관리
  - 센터가 사용하는 강습 공간 추가/수정/삭제
  - 수업 등록 시 이 룸 목록에서 선택
*/

import { useCallback, useEffect, useState } from "react";
import ManagerNav from "../../components/ManagerNav";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchRooms, addRoom, updateRoom, deleteRoom, type Room } from "../../../lib/rooms";
import Loading from "../../components/Loading";
import MapPicker from "../center-info/MapPicker";
import MapPreview from "../../components/MapPreview";

export default function RoomsPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 추가/수정 시트
  const [editing, setEditing] = useState<Room | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [memo, setMemo] = useState("");
  const [address, setAddress] = useState("");
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [mapPicker, setMapPicker] = useState(false);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2000); }

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
    try { setRooms(await fetchRooms(centerId)); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);
  useEffect(() => { load(); }, [load]);

  function openAdd() { setAdding(true); setEditing(null); setName(""); setMemo(""); setAddress(""); setLat(null); setLng(null); }
  function openEdit(r: Room) { setEditing(r); setAdding(false); setName(r.name); setMemo(r.memo ?? ""); setAddress(r.address ?? ""); setLat(r.latitude); setLng(r.longitude); }
  function closeSheet() { setAdding(false); setEditing(null); }

  async function handleSave() {
    if (!name.trim()) { setError("룸 이름을 입력해주세요"); return; }
    if (!centerId) return;
    setBusy(true);
    try {
      const input = { name: name.trim(), memo: memo.trim(), address: address.trim(), latitude: lat, longitude: lng };
      if (editing) { await updateRoom(editing.id, input); showToast("룸을 수정했어요"); }
      else { await addRoom(centerId, input); showToast("룸을 추가했어요"); }
      closeSheet();
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(r: Room) {
    if (!confirm(`'${r.name}' 룸을 삭제할까요? (이 룸으로 지정된 수업은 장소가 비워져요)`)) return;
    setBusy(true);
    try { await deleteRoom(r.id); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">룸(장소) 관리</div>
        <div className="side" />
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>{c.name}</button>
          ))}
        </div>
      )}

      {loading ? <Loading /> : (
        <>
          {rooms.length === 0 ? (
            <div className="empty-action">
              <div className="empty-action-text">아직 등록된 룸이 없어요.<br />수업을 진행하는 공간을 추가해보세요.</div>
              <button className="empty-action-btn" onClick={openAdd}>+ 첫 룸 추가하기</button>
            </div>
          ) : (
            <div className="profile-list">
              {rooms.map((r) => (
                <div key={r.id} className="profile-item">
                  <button className="profile-item-info" style={{ textAlign: "left", background: "none", border: "none", flex: 1 }} onClick={() => openEdit(r)}>
                    <div className="profile-item-name">🚪 {r.name}</div>
                    {r.memo && <div className="profile-item-sub">{r.memo}</div>}
                    {r.address && <div className="profile-item-sub">📍 {r.address}</div>}
                  </button>
                  <button className="room-edit" onClick={() => openEdit(r)}>수정</button>
                  <button className="profile-del" disabled={busy} onClick={() => handleDelete(r)}>삭제</button>
                </div>
              ))}
            </div>
          )}

          {rooms.length > 0 && (
            <button className="add-profile-btn" onClick={openAdd}>+ 룸 추가</button>
          )}
        </>
      )}

      {/* 추가/수정 시트 */}
      {(adding || editing) && (
        <div className="sheet-overlay" onClick={closeSheet}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{editing ? "룸 수정" : "룸 추가"}</div>
            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>룸 이름</div>
            <input className="input-field" placeholder="예: A룸, 1번 스튜디오" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "10px 0 6px" }}>설명 (선택)</div>
            <input className="input-field" placeholder="예: 2층, 거울방" value={memo} onChange={(e) => setMemo(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "10px 0 6px" }}>주소 (회원 길찾기용, 선택)</div>
            <input className="input-field" placeholder="예: 서울 강남구 ..." value={address} onChange={(e) => setAddress(e.target.value)} />
            {lat != null && lng != null ? (
              <>
                <MapPreview lat={lat} lng={lng} />
                <button className="ghost-btn" style={{ marginTop: 8 }} onClick={() => setMapPicker(true)}>위치 수정하기</button>
              </>
            ) : (
              <button className="ghost-btn" style={{ marginTop: 8 }} onClick={() => setMapPicker(true)}>🗺️ 지도에서 위치 지정</button>
            )}
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={closeSheet}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleSave}>{editing ? "수정하기" : "추가하기"}</button>
            </div>
          </div>
        </div>
      )}

      {mapPicker && (
        <MapPicker
          initialLat={lat}
          initialLng={lng}
          onPick={(la, ln) => { setLat(la); setLng(ln); showToast("지도에서 위치를 지정했어요"); }}
          onClose={() => setMapPicker(false)}
        />
      )}
      <ManagerNav />
    </div>
  );
}
