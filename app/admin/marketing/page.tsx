"use client";

/*
  운영자 - 마케팅 알림
  - 공지사항(센터별)과 별개로, 플랫폼 전체 회원에게 혜택·이벤트 알림을 발송한다.
  - 발송하면 알림함(/notifications) + 실시간 팝업(켜둔 회원만, "혜택·이벤트 알림" 토글) +
    웹/네이티브 푸시(구독한 회원만)로 전달된다.
*/

import { useCallback, useEffect, useState } from "react";
import { fetchMarketingMessages, sendMarketingMessage, type MarketingMessage } from "../../../lib/marketing";
import { checkPlatformAdmin } from "../../../lib/admin";
import Loading from "../../components/Loading";

export default function MarketingPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<MarketingMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2000); }

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setMessages(await fetchMarketingMessages()); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    (async () => {
      const admin = await checkPlatformAdmin();
      setIsAdmin(admin);
      if (admin) await load();
      else setLoading(false);
    })();
  }, [load]);

  async function handleSend() {
    if (!title.trim() || !body.trim()) { setError("제목과 내용을 모두 입력해주세요"); return; }
    if (!(await globalThis.appConfirm("전체 회원에게 이 알림을 발송할까요?\n발송 후에는 되돌릴 수 없어요."))) return;
    setBusy(true);
    try {
      await sendMarketingMessage(title.trim(), body.trim(), link.trim());
      setTitle(""); setBody(""); setLink(""); setComposing(false);
      showToast("발송했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (isAdmin === false) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/admin">‹</a>
          <div className="title">마케팅 알림</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>
          플랫폼 운영자만 접근할 수 있는 화면이에요
        </div>
      </div>
    );
  }

  if (isAdmin === null || loading) {
    return (
      <div className="app-shell">
        <Loading />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/admin">‹</a>
        <div className="title">마케팅 알림</div>
        <div className="side" />
      </div>

      <div className="perm-guide" style={{ margin: "8px 20px" }}>
        센터별 공지사항과 달리, 여기서 보내면 전체 회원에게 한 번에 발송돼요. 회원이 "혜택·이벤트
        알림"을 꺼두면 팝업은 안 뜨지만 알림함에는 그대로 남아요.
      </div>

      {composing ? (
        <div className="add-profile-form">
          <input className="input-field" placeholder="제목 (필수)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input className="input-field" placeholder="내용 (필수)" value={body} onChange={(e) => setBody(e.target.value)} />
          <input className="input-field" placeholder="이동 링크 (선택, 예: /reservation)" value={link} onChange={(e) => setLink(e.target.value)} />
          <div className="add-profile-actions">
            <button className="ghost-btn" onClick={() => { setComposing(false); setError(null); }}>취소</button>
            <button className="primary-btn" disabled={busy} onClick={() => handleSend()}>{busy ? "발송 중" : "발송하기"}</button>
          </div>
        </div>
      ) : (
        <button className="add-profile-btn" onClick={() => setComposing(true)}>+ 새 마케팅 알림 발송</button>
      )}

      <div className="menu-section-label">발송 내역</div>
      <div className="profile-list">
        {messages.length === 0 ? (
          <div className="daylist-empty" style={{ padding: 20 }}>발송 내역이 없어요</div>
        ) : messages.map((m) => (
          <div key={m.id} className="banner-admin-row">
            <div className="banner-admin-main">
              <div className="banner-admin-title">{m.title}</div>
              <div className="banner-admin-sub">{m.body}</div>
              {m.link && <div className="banner-admin-link">→ {m.link}</div>}
            </div>
            <div className="banner-admin-actions">
              <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{m.targetCount}명 발송</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
