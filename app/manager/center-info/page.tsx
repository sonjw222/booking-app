"use client";

/*
  매니저 - 센터 정보 편집
  - 소개글 / 주소 / 연락처 (센터 상세 화면에 노출됨)
  - 시설 정보 설정 권한(facility.info) 필요 — 오너는 항상 가능
*/

import { useCallback, useEffect, useState } from "react";
import ManagerNav from "../../components/ManagerNav";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchCenterDetail, updateCenterIntro, uploadCenterPhoto, centerPhotoUrl, type IntroBlock } from "../../../lib/center";
import MapPicker from "./MapPicker";
import MapPreview from "../../components/MapPreview";
import RichTextEditor from "../../components/RichTextEditor";
import { fetchCategories, type ServiceCategory } from "../../../lib/operator";

// 구버전 평문 블록을 HTML로 변환 (줄바꿈 유지 + 태그 이스케이프)
function escapeToHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

export default function CenterInfoPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [intro, setIntro] = useState("");
  const [introBlocks, setIntroBlocks] = useState<IntroBlock[]>([]);
  const [uploadingBlock, setUploadingBlock] = useState(false);
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [catOptions, setCatOptions] = useState<ServiceCategory[]>([]);
  const [sns, setSns] = useState("");
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [mapPicker, setMapPicker] = useState(false);
  const [payMethods, setPayMethods] = useState<string[]>([]);
  const [reviewPoint, setReviewPoint] = useState("1000");
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  // --- 소개 블록 편집 ---
  function addTextBlock() { setIntroBlocks((b) => [...b, { type: "text", value: "" }]); }
  async function addImageBlock(file: File) {
    setUploadingBlock(true);
    try {
      const path = await uploadCenterPhoto(file);
      setIntroBlocks((b) => [...b, { type: "image", value: path }]);
    } catch (e: any) { setError(e.message); }
    finally { setUploadingBlock(false); }
  }
  // 리치 텍스트 저장 (html + 검색/미리보기용 평문 value 동시 갱신)
  function updateBlockHtml(i: number, html: string) {
    const plain = html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");
    setIntroBlocks((b) => b.map((blk, idx) =>
      idx === i && blk.type === "text" ? { ...blk, html, value: plain } : blk));
  }
  // 정렬·글자크기 등 블록 속성 변경
  function updateBlockField(i: number, patch: Partial<Extract<IntroBlock, { type: "text" }>>) {
    setIntroBlocks((b) => b.map((blk, idx) =>
      idx === i && blk.type === "text" ? { ...blk, ...patch } : blk));
  }
  function removeBlock(i: number) { setIntroBlocks((b) => b.filter((_, idx) => idx !== i)); }
  function moveBlock(i: number, dir: number) {
    setIntroBlocks((b) => {
      const j = i + dir;
      if (j < 0 || j >= b.length) return b;
      const copy = [...b];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

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
      const c = await fetchCenterDetail(centerId);
      // 승인 전 센터는 fetchCenterDetail이 null → manager 목록의 이름만이라도
      setIntro(c?.intro ?? "");
      setPayMethods(c?.payMethods ?? []);
      setReviewPoint(String(c?.reviewPoint ?? 1000));
      // 블록이 없고 옛 소개글만 있으면 텍스트 블록 하나로 변환
      const blocks = c?.introBlocks ?? [];
      if (blocks.length === 0 && c?.intro) setIntroBlocks([{ type: "text", value: c.intro }]);
      else setIntroBlocks(blocks);
      setAddress(c?.address ?? "");
      setPhone(c?.phone ?? "");
      setPhotoUrl(c?.photoUrl ?? null);
      setCategories(c?.categories ?? []);
      try { setCatOptions(await fetchCategories()); } catch { /* 무시 */ }
      setSns(c?.sns ?? "");
      setLat(c?.latitude ?? null);
      setLng(c?.longitude ?? null);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  async function handleSave() {
    if (!centerId) return;
    setBusy(true);
    try {
      await updateCenterIntro(centerId, {
        intro: intro.trim(), address: address.trim(), phone: phone.trim(),
        photoUrl, sns: sns.trim(), categories, latitude: lat, longitude: lng,
        introBlocks,
        payMethods,
        reviewPoint: parseInt(reviewPoint || "0", 10) || 0,
      });
      showToast("저장했어요");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">센터 정보</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">센터 정보</div>
        <button className="header-action" disabled={busy} onClick={handleSave}>{busy ? "저장 중" : "저장"}</button>
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="perm-guide">
        여기 입력한 내용이 회원에게 보이는 <b>센터 상세 화면</b>에 표시돼요.
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {mapPicker && (
        <MapPicker
          initialLat={lat}
          initialLng={lng}
          onPick={(la, ln) => { setLat(la); setLng(ln); showToast("지도에서 위치를 지정했어요"); }}
          onClose={() => setMapPicker(false)}
        />
      )}

      {loading ? (
        <Loading />
      ) : (
        <div style={{ padding: "0 20px 40px" }}>
          <div className="menu-section-label" style={{ padding: "8px 0 6px" }}>종목 (여러 개 선택 가능 · 홈 분류용)</div>
          <div className="mem-filters" style={{ padding: 0, marginBottom: 4 }}>
            {catOptions.map((cat) => (
              <button key={cat.id} className={`filter-chip ${categories.includes(cat.label) ? "on" : ""}`}
                onClick={() => setCategories((prev) => prev.includes(cat.label) ? prev.filter((x) => x !== cat.label) : [...prev, cat.label])}>
                {cat.emoji} {cat.label}
              </button>
            ))}
          </div>

          <div className="menu-section-label" style={{ padding: "8px 0 6px" }}>프로필 사진 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 센터 이름 위에 뜨는 작은 사진</span></div>
          <div className="avatar-edit" style={{ alignItems: "flex-start" }}>
            {photoUrl
              ? <img className="center-photo-preview" src={centerPhotoUrl(photoUrl) ?? ""} alt="" />
              : <div className="center-photo-placeholder">사진 없음</div>}
            <label className="avatar-edit-btn">
              {uploadingPhoto ? "업로드 중..." : "사진 변경"}
              <input type="file" accept="image/*" hidden onChange={async (e) => {
                const f = e.target.files?.[0]; if (!f || !centerId) return;
                setUploadingPhoto(true);
                try { setPhotoUrl(await uploadCenterPhoto(f)); }
                catch (err: any) { setError(err.message); }
                finally { setUploadingPhoto(false); }
              }} />
            </label>
          </div>

          <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>주소</div>
          <input className="input-field" placeholder="예: 서울 강남구 ..." value={address} onChange={(e) => setAddress(e.target.value)} />

          <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>센터 위치</div>
          {lat != null && lng != null && <MapPreview lat={lat} lng={lng} />}
          <div className="loc-btn-row">
            <button className="ghost-btn" onClick={() => {
              if (!navigator.geolocation) { setError("이 브라우저는 위치를 지원하지 않아요"); return; }
              navigator.geolocation.getCurrentPosition(
                (pos) => { setLat(pos.coords.latitude); setLng(pos.coords.longitude); showToast("현재 위치를 저장했어요"); },
                () => setError("위치를 가져올 수 없어요 (권한 확인)")
              );
            }}>현재위치</button>
            <button className="ghost-btn" onClick={() => setMapPicker(true)}>위치찾기</button>
          </div>
          {lat != null && lng != null && (
            <div className="perm-guide" style={{ margin: "6px 0 0" }}>
              회원 홈에서 가까운 순으로 노출되고, 길찾기 목적지로 쓰여요
            </div>
          )}

          <div className="menu-section-label" style={{ padding: "18px 0 6px" }}>센터 소개 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 사진과 글을 자유롭게 배치</span></div>
          <div className="intro-editor">
            {introBlocks.length === 0 && (
              <div className="perm-guide" style={{ margin: "0 0 8px" }}>아래 버튼으로 글이나 사진을 추가해보세요.</div>
            )}
            {introBlocks.map((blk, i) => (
              <div key={i} className="intro-block">
                <div className="intro-block-controls">
                  <button className="ib-btn" onClick={() => moveBlock(i, -1)} disabled={i === 0}>↑</button>
                  <button className="ib-btn" onClick={() => moveBlock(i, 1)} disabled={i === introBlocks.length - 1}>↓</button>
                  <button className="ib-btn del" onClick={() => removeBlock(i)}>✕</button>
                </div>
                {blk.type === "text" ? (
                  <RichTextEditor
                    html={blk.html ?? escapeToHtml(blk.value)}
                    align={blk.align ?? "left"}
                    fontSize={blk.fontSize ?? 14}
                    onChangeHtml={(h) => updateBlockHtml(i, h)}
                    onChangeAlign={(a) => updateBlockField(i, { align: a })}
                    onChangeFontSize={(n) => updateBlockField(i, { fontSize: n })}
                  />
                ) : (
                  <img className="intro-block-img" src={centerPhotoUrl(blk.value) ?? ""} alt="" />
                )}
              </div>
            ))}
            <div className="intro-add-row">
              <button className="ghost-btn" style={{ flex: 1 }} onClick={addTextBlock}>+ 글 추가</button>
              <label className="ghost-btn" style={{ flex: 1, textAlign: "center", cursor: "pointer" }}>
                {uploadingBlock ? "업로드 중..." : "+ 사진 추가"}
                <input type="file" accept="image/*" hidden onChange={(e) => {
                  const f = e.target.files?.[0]; if (f) addImageBlock(f); e.target.value = "";
                }} />
              </label>
            </div>
          </div>

          <div className="menu-section-label" style={{ padding: "18px 0 6px" }}>결제 수단 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 회원 결제화면에 보일 수단</span></div>
          <div className="mem-filters" style={{ padding: 0 }}>
            {[
              { id: "card", label: "카드" },
              { id: "kakao", label: "카카오페이" },
              { id: "toss", label: "토스페이" },
              { id: "transfer", label: "계좌이체" },
              { id: "direct", label: "직접결제" },
            ].map((m) => (
              <button key={m.id} className={`filter-chip ${payMethods.includes(m.id) ? "on" : ""}`}
                onClick={() => setPayMethods((prev) => prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id])}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="perm-guide" style={{ margin: "6px 0 0" }}>
            아무것도 선택하지 않으면 전체 수단이 보여요.
          </div>

          <div className="menu-section-label" style={{ padding: "18px 0 6px" }}>후기 작성 포인트 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 회원이 후기를 쓰면 지급</span></div>
          <input className="input-field" inputMode="numeric" placeholder="예: 1000"
            value={reviewPoint} onChange={(e) => setReviewPoint(e.target.value.replace(/[^0-9]/g, ""))} />
          <div className="perm-guide" style={{ margin: "4px 0 0" }}>
            0으로 두면 포인트를 지급하지 않아요. 적립된 포인트는 이 센터 결제에만 쓸 수 있어요.
          </div>

          <div className="menu-section-label" style={{ padding: "18px 0 6px" }}>연락처</div>
          <input className="input-field" placeholder="예: 02-1234-5678" value={phone} onChange={(e) => setPhone(e.target.value)} />

          <div className="menu-section-label" style={{ padding: "18px 0 6px" }}>SNS (한 줄에 하나씩)</div>
          <textarea
            className="input-field"
            style={{ minHeight: 90, resize: "vertical", lineHeight: 1.6 }}
            placeholder={"예:\n인스타그램 @mystudio\n카카오톡 채널 mystudio\n네이버 예약 ..."}
            value={sns}
            onChange={(e) => setSns(e.target.value)}
          />
        </div>
      )}
      <ManagerNav />
    </div>
  );
}
