"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Loading from "../../components/Loading";
import {
  fetchGrades, fetchMemberDetail, fetchMembers,
  updateMemberAddress, updateMemberGrade, updateMemberMemo, updateMemberStatus,
  type CenterMember, type Grade, type MemberDetailData,
} from "../../../lib/members";

const STATUS_LABEL = { active: "이용 중", dormant: "휴면", expired: "만료" } as const;
const RES_STATUS: Record<string,string> = { confirmed: "확정", waitlisted: "대기", cancelled: "취소", attended: "출석", no_show: "노쇼" };
const SALE_LABEL: Record<string,string> = { new: "신규", renew: "재결제", trial: "체험", upgrade: "업그레이드", refund: "환불", unpaid_pay: "미수금", transfer_fee: "양도" };

export default function MemberDetailPage() {
  return <Suspense fallback={<Loading />}><MemberDetailContent /></Suspense>;
}

function MemberDetailContent() {
  const params = useSearchParams();
  const centerId = params.get("center") ?? "";
  const profileId = params.get("profile") ?? "";
  const [member, setMember] = useState<CenterMember | null>(null);
  const [detail, setDetail] = useState<MemberDetailData | null>(null);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [tab, setTab] = useState<"info"|"reservations"|"progress"|"payments">("info");
  const [memo, setMemo] = useState("");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function load() {
    if (!centerId || !profileId) { setError("회원 정보가 올바르지 않아요"); setLoading(false); return; }
    setLoading(true);
    try {
      const [members, data, gradeRows] = await Promise.all([fetchMembers(centerId), fetchMemberDetail(profileId), fetchGrades(centerId)]);
      const found = members.find((item) => item.profileId === profileId) ?? null;
      setMember(found); setDetail(data); setGrades(gradeRows);
      setMemo(found?.memo ?? ""); setAddress(found?.address ?? "");
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [centerId, profileId]);

  async function saveNotes() {
    if (!member) return;
    setBusy(true);
    try {
      await Promise.all([updateMemberMemo(member.id, memo), updateMemberAddress(profileId, address)]);
      setToast("회원 정보를 저장했어요"); setTimeout(() => setToast(null), 2200);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function setStatus(status: CenterMember["status"]) {
    if (!member) return;
    setBusy(true); try { await updateMemberStatus(member.id, status); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function setGrade(gradeId: string | null) {
    if (!member) return;
    setBusy(true); try { await updateMemberGrade(member.id, gradeId); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  if (loading) return <div className="app-shell manager-member-detail"><Loading /></div>;
  if (!member || !detail) return <div className="app-shell manager-member-detail"><div className="daylist-empty">{error ?? "회원을 찾지 못했어요"}</div></div>;

  const passes = detail.activePasses.filter((item) => item.kind !== "goods");
  return <div className="app-shell manager-member-detail">
    {toast && <div className="toast">{toast}</div>}
    {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
    <header className="member-detail-hero">
      <div className="member-detail-avatar">{member.name.slice(0,1)}</div>
      <div><h2>{member.name}</h2><p>{member.phone ?? "연락처 없음"} · {STATUS_LABEL[member.status]}</p></div>
    </header>

    {passes.length > 0 && <section className="member-detail-passes">
      <h3>보유 수강권 <span>{passes.length}</span></h3>
      {passes.map((pass) => <div className="member-detail-pass" key={pass.id}><b>{pass.name}</b><span>{pass.remaining != null ? `${pass.remaining}회 남음` : "사용 가능"} · {pass.expiresAt}까지</span></div>)}
    </section>}

    <nav className="member-detail-tabs">
      {([['info','정보'],['reservations','예약'],['progress','진도'],['payments','결제']] as const).map(([key,label]) => <button key={key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{label}</button>)}
    </nav>

    {tab === "info" && <main className="member-detail-section">
      <div className="member-detail-facts">
        <div><span>등록일</span><b>{member.registeredAt}</b></div><div><span>최근 출석</span><b>{member.lastAttendedAt ?? "기록 없음"}</b></div><div><span>앱 연결</span><b>{member.appLinked ? "연결됨" : "미연결"}</b></div>
      </div>
      <h3>회원 상태</h3><div className="member-detail-choices">{Object.entries(STATUS_LABEL).map(([key,label]) => <button disabled={busy} className={member.status === key ? "on" : ""} key={key} onClick={() => setStatus(key as CenterMember["status"])}>{label}</button>)}</div>
      <h3>등급</h3><div className="member-detail-choices"><button className={!member.gradeId ? "on" : ""} onClick={() => setGrade(null)}>없음</button>{grades.map((grade) => <button className={member.gradeId === grade.id ? "on" : ""} key={grade.id} onClick={() => setGrade(grade.id)}>{grade.name}</button>)}</div>
      <h3>관리 정보</h3><label className="member-detail-field"><span>주소</span><input className="input-field" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="주소 입력" /></label>
      <label className="member-detail-field"><span>관리자 메모 <small>회원에게 보이지 않아요</small></span><textarea className="input-field" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="부상 이력, 상담 내용 등" /></label>
      <button className="primary-btn member-detail-save" disabled={busy} onClick={saveNotes}>{busy ? "저장 중" : "변경사항 저장"}</button>
    </main>}

    {tab === "reservations" && <main className="member-detail-section member-detail-feed">{detail.reservations.length === 0 ? <div className="daylist-empty">예약 내역이 없어요</div> : detail.reservations.map((item) => <div key={item.id}><span>{item.date}</span><b>{item.title}</b><em>{RES_STATUS[item.status] ?? item.status}</em></div>)}</main>}
    {tab === "progress" && <main className="member-detail-section member-detail-feed">{detail.progress.length === 0 ? <div className="daylist-empty">진도 기록이 없어요</div> : detail.progress.map((item) => <div key={item.id}><span>{item.date}</span><b>{item.skill}</b><em>{item.note ?? ""}</em></div>)}</main>}
    {tab === "payments" && <main className="member-detail-section member-detail-feed">{detail.payments.length === 0 ? <div className="daylist-empty">결제 내역이 없어요</div> : detail.payments.map((item) => <div key={item.id}><span>{item.date}</span><b>{SALE_LABEL[item.saleType] ?? item.saleType}</b><em>{item.amount.toLocaleString("ko-KR")}원</em></div>)}</main>}
  </div>;
}
