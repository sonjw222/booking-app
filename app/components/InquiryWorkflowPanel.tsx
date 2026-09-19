"use client";
import { useEffect, useRef, useState } from "react";
import { getInquiryWorkflow, saveInquiryWorkflow, INQUIRY_STATUSES, type InquiryWorkflow } from "../../lib/inquiryWorkflow";
import { useUnsavedChanges, confirmDiscardChanges } from "../../lib/useUnsavedChanges";
export default function InquiryWorkflowPanel({ threadId, canEdit }: { threadId: string; canEdit: boolean }) {
  const [workflow, setWorkflow] = useState<InquiryWorkflow | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const [saved, setSaved] = useState("");
  useUnsavedChanges(!!note.trim() || (!!workflow && saved !== JSON.stringify([workflow.status, workflow.assigneeId])));
  useEffect(() => {
    let active = true;
    setError("");
    getInquiryWorkflow(threadId).then((data) => { if (active) { setWorkflow(data); setSaved(JSON.stringify([data.status, data.assigneeId])); } }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [threadId, refresh]);
  async function save() {
    if (!canEdit || !workflow || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { const next = await saveInquiryWorkflow(threadId, workflow, note); setWorkflow(next); setSaved(JSON.stringify([next.status, next.assigneeId])); setNote(""); }
    catch (e) { setError(e instanceof Error ? e.message : "저장하지 못했어요"); }
    finally { lock.current = false; setBusy(false); }
  }
  return <details className="inquiry-workflow-panel"><summary>담당자·처리상태·내부 메모</summary>
    {error && <p role="alert">{error}</p>}
    <button type="button" className="outline-action" disabled={busy} onClick={async () => { if (await confirmDiscardChanges()) setRefresh((n) => n + 1); }}>최신 상태 불러오기</button>
    {workflow && <>
      <div className="workflow-toolbar">
        <label>처리상태<select className="input-field" disabled={!canEdit || busy} value={workflow.status} onChange={(e) => setWorkflow({ ...workflow, status: e.target.value as InquiryWorkflow["status"] })}>{Object.entries(INQUIRY_STATUSES).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>담당자<select className="input-field" disabled={!canEdit || busy} value={workflow.assigneeId ?? ""} onChange={(e) => setWorkflow({ ...workflow, assigneeId: e.target.value || null })}><option value="">미배정</option>{workflow.staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      </div>
      {workflow.members.length > 0 && <nav aria-label="문의 회원 정보">{workflow.members.map((person) => <a key={person.id} className="outline-action" href={`/manager/members?profile=${encodeURIComponent(person.id)}`}>{person.name} 회원 정보</a>)}</nav>}
      {canEdit && <label>내부 메모 — 회원에게 보이지 않습니다<textarea className="input-field" maxLength={4000} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} /><button type="button" className="primary-btn" disabled={busy} onClick={save}>{busy ? "저장 중…" : "업무 상태·메모 저장"}</button></label>}
      <ul>{workflow.notes.map((item) => <li key={item.id}><b>{item.author}</b> · <time>{new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Seoul" }).format(new Date(item.createdAt))}</time><p>{item.body}</p></li>)}</ul>
    </>}
  </details>;
}
