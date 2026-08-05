"use client";

/*
  1:1 문의 채팅방 (회원/매니저 공용)
  - 메시지 목록 + 입력창 + 사진 전송
  - 실시간 구독으로 새 메시지 즉시 반영
  - 들어오면 읽음 처리
*/

import { useEffect, useRef, useState } from "react";
import { ZoomableImage } from "./ImageViewer";
import {
  fetchMessages, sendMessage, readThread, subscribeMessages,
  uploadInquiryPhoto, inquiryPhotoUrl, type InquiryMessage,
} from "../../lib/inquiries";

export default function InquiryChat({
  threadId, title, onBack,
}: {
  threadId: string;
  title: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<InquiryMessage[]>([]);
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function reload() {
    try {
      const ms = await fetchMessages(threadId);
      setMessages(ms);
    } catch (e: any) {
      setError("메시지를 불러오지 못했어요: " + e.message);
    }
  }

  useEffect(() => {
    (async () => {
      await reload();
      setLoading(false);
      await readThread(threadId);
    })();
    const unsub = subscribeMessages(threadId, async () => {
      await reload();
      await readThread(threadId);
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const body = text.trim();
    if (!body && photos.length === 0) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(threadId, body, photos);
      setText(""); setPhotos([]);
      await reload();
    } catch (e: any) {
      setError("전송에 실패했어요: " + e.message);
    } finally { setSending(false); }
  }

  async function handlePhoto(file: File) {
    setUploading(true);
    setError(null);
    try {
      const path = await uploadInquiryPhoto(file);
      setPhotos((prev) => [...prev, path]);
    } catch (e: any) {
      setError("사진 업로드에 실패했어요: " + e.message);
    } finally { setUploading(false); }
  }

  return (
    <div className="chat-wrap">
      <div className="chat-header">
        <button className="chat-back" onClick={onBack}>‹</button>
        <span className="chat-title">{title}</span>
      </div>

      <div className="chat-body">
        {loading ? (
          <div className="chat-empty">불러오는 중…</div>
        ) : messages.length === 0 ? (
          <div className="chat-empty">첫 메시지를 남겨보세요.</div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.mine ? "mine" : "theirs"}`}>
              <div className="chat-bubble">
                {m.body && <div className="chat-text">{m.body}</div>}
                {m.photos && m.photos.length > 0 && (
                  <div className="chat-photos">
                    {m.photos.map((ph, i) => (
                      <ZoomableImage
                        key={i} src={inquiryPhotoUrl(ph) ?? ""}
                        group={m.photos!.map((p) => inquiryPhotoUrl(p) ?? "")} groupIndex={i}
                      />
                    ))}
                  </div>
                )}
              </div>
              <div className="chat-time">{m.createdAt}</div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* 선택한 사진 미리보기 */}
      {photos.length > 0 && (
        <div className="chat-photo-preview">
          {photos.map((ph, i) => (
            <div key={i} className="chat-photo-thumb">
              <img src={inquiryPhotoUrl(ph) ?? ""} alt="" />
              <button onClick={() => setPhotos((prev) => prev.filter((_, x) => x !== i))}>×</button>
            </div>
          ))}
        </div>
      )}

      {error && <div className="auth-msg error" style={{ margin: "0 12px 8px" }}>{error}</div>}

      <div className="chat-input-bar">
        <label className="chat-photo-btn">
          {uploading ? "…" : "＋"}
          <input type="file" accept="image/*" hidden onChange={async (e) => {
            const f = e.target.files?.[0]; if (!f) return;
            await handlePhoto(f); e.target.value = "";
          }} />
        </label>
        <textarea
          className="chat-input"
          placeholder="메시지를 입력하세요"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
          }}
          rows={1}
        />
        <button className="chat-send" disabled={sending} onClick={handleSend}>전송</button>
      </div>
    </div>
  );
}
