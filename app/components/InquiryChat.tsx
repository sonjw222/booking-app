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
  fetchMessages, sendMessage, readThread, subscribeMessages, mapInquiryMessageRow,
  uploadInquiryPhoto, inquiryPhotoUrl, deleteMessage, type InquiryMessage,
} from "../../lib/inquiries";
import { getMyAccountId } from "../../lib/authAccount";

export default function InquiryChat({
  threadId, title, onBack, canSend = true, canDeleteOthers = false,
}: {
  threadId: string;
  title: string;
  onBack: () => void;
  canSend?: boolean; // 매니저 쪽에서 board.inquiry.comment 권한이 없을 때만 false — 회원 쪽은 항상 true(생략 시 기본값)
  canDeleteOthers?: boolean; // board.inquiry.comment_other — 다른 스태프가 보낸 메시지도 삭제 가능. 회원 쪽은 항상 false(생략 시 기본값)
}) {
  const [messages, setMessages] = useState<InquiryMessage[]>([]);
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 마운트 시 한 번만 조회해 재사용 — fetchMessages()/실시간 append 양쪽에서 매번
  // getMyAccountId()를 다시 부르지 않게 한다(왕복 1회 절감).
  const myAccountIdRef = useRef<string | null>(null);

  async function reload() {
    try {
      const ms = await fetchMessages(threadId, myAccountIdRef.current);
      setMessages(ms);
    } catch (e: any) {
      setError("메시지를 불러오지 못했어요: " + e.message);
    }
  }

  // 실시간 INSERT로 들어온 행 하나만 화면에 반영 — 스레드 전체를 다시 조회하지
  // 않는다. id로 중복 체크해두면 재연결 등으로 같은 이벤트가 두 번 오거나(드묾),
  // 방금 내가 보낸 메시지의 realtime echo가 이미 반영된 상태와 겹쳐도 안전하다.
  function appendMessage(row: Parameters<typeof mapInquiryMessageRow>[0]) {
    const msg = mapInquiryMessageRow(row, myAccountIdRef.current);
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  }

  useEffect(() => {
    (async () => {
      myAccountIdRef.current = await getMyAccountId();
      await reload();
      setLoading(false);
      await readThread(threadId);
    })();
    const unsub = subscribeMessages(threadId, async (row) => {
      appendMessage(row);
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
      // 화면 갱신은 reload()가 아니라 이 전송으로 발생한 실시간 INSERT 이벤트가
      // appendMessage()로 처리한다 — 여기서 다시 fetchMessages()를 부르면 메시지
      // 1건 전송에 REST 요청이 두 번(이 reload + 실시간이 유발하던 예전 reload)
      // 나가던 중복이었다.
    } catch (e: any) {
      setError("전송에 실패했어요: " + e.message);
    } finally { setSending(false); }
  }

  async function handleDelete(messageId: string) {
    if (!(await globalThis.appConfirm("이 메시지를 삭제할까요?"))) return;
    setError(null);
    try {
      await deleteMessage(messageId);
      // 삭제는 실시간 이벤트를 안 듣고 있으니(DELETE 구독 없음) 방금 지운 메시지를
      // 로컬 state에서 직접 제거한다 — 이 한 건 때문에 스레드 전체를 다시 조회할
      // 필요는 없음.
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    } catch (e: any) {
      setError("삭제에 실패했어요: " + e.message);
    }
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
          messages.map((m) => {
            // 회원 메시지는 이 삭제 기능의 대상이 아님(board.inquiry.comment*는 스태프
            // 게시판 관리용 권한) — RPC도 같은 규칙을 강제하지만 버튼도 여기서 미리 숨긴다.
            const canDelete = m.senderRole === "manager" && (m.mine || canDeleteOthers);
            return (
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
                <div className="chat-time">
                  {m.createdAt}
                  {canDelete && (
                    <button className="chat-delete-btn" onClick={() => handleDelete(m.id)}>삭제</button>
                  )}
                </div>
              </div>
            );
          })
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

      {canSend ? (
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
      ) : (
        <div className="auth-msg" style={{ margin: "0 12px 12px", textAlign: "center" }}>
          문의 답변 권한이 없어요 — 오너에게 문의하세요.
        </div>
      )}
    </div>
  );
}
