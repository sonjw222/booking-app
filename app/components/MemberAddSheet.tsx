"use client";

import { useEffect, useRef, useState } from "react";
import { searchAccountsForMember, type MemberCandidate } from "../../lib/members";
import SheetOverlay from "./SheetOverlay";

/*
  관리자 > 회원 > "+회원" 추가 시트(2026-10-04 분리). 검색은 서버 RPC(search_member_candidates)가 센터별 권한을 확인한다 — 여기서는 "RPC가 준 결과가 화면에서 사라지지 않게" 하는 클라이언트 방어만 한다.
  · 최신 요청만 반영(sequence ref): 늦게 끝난 이전 응답/오류가 최신 결과를 덮지 못하고, 같은 검색어의 in-flight 중복 요청(Enter 연타)은 만들지 않는다. 검색 시작 시점의 centerId/검색어를 snapshot한다.
  · centerId가 바뀌면 이전 센터의 결과/오류/진행 중 요청을 폐기한다(진행 중 응답은 sequence 증가로 무시).
  · 오류는 토스트뿐 아니라 시트 안에도 표시하고, 이전 결과를 남기지 않는다. "검색 전 / 검색 중 / 결과 있음 / 진짜 0건 / 오류"를 구분해 표시한다.
  · 이미 이 센터에 등록된 회원(already_member)은 검색 성공 결과로 이름/전화번호와 함께 "이미 이 센터에 등록된 회원이에요"를 명확히 표시한다(등록 버튼만 없다).
  · 검색을 시작하면 입력칸을 blur해 모바일 키보드를 내린다 — 키보드가 결과를 가려 "결과 없음"처럼 보이는 것을 막고, 결과가 도착하면 목록이 보이도록 스크롤한다.
  · 개인정보: 검색어/이름/전화번호/profile id를 로그에 남기지 않는다.
*/
type Props = {
  centerId: string;
  centerName?: string | null;
  busy?: boolean;
  onClose: () => void;
  onAdd: (profileId: string) => void;
};

export default function MemberAddSheet({ centerId, centerName, busy = false, onClose, onAdd }: Props) {
  const [kw, setKw] = useState("");
  const [results, setResults] = useState<MemberCandidate[]>([]);
  const [searchedKw, setSearchedKw] = useState<string | null>(null);   // null = 아직 검색 안 함
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const inflightRef = useRef<string | null>(null);   // `${centerId}|${query}` — 같은 요청의 중복 시작 방지
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 센터가 바뀌거나 시트가 닫히면 이전 센터의 상태/진행 중 응답을 폐기한다.
  useEffect(() => {
    seqRef.current++; inflightRef.current = null;
    setResults([]); setSearchedKw(null); setSearching(false); setError(null);
    return () => { seqRef.current++; inflightRef.current = null; };
  }, [centerId]);

  async function runSearch() {
    const query = kw.trim();
    const cid = centerId;
    const key = `${cid}|${query}`;
    if (inflightRef.current === key) return;          // 같은 검색을 이미 진행 중(Enter 연타)
    const seq = ++seqRef.current;                       // 새 요청이 이전 요청을 무효화
    inflightRef.current = key;
    setSearching(true); setError(null);
    inputRef.current?.blur();                           // 키보드를 내려 결과가 가려지지 않게
    try {
      const r = await searchAccountsForMember(cid, query);
      if (seq !== seqRef.current) return;               // stale 응답은 버린다
      setResults(r); setSearchedKw(query);
      requestAnimationFrame?.(() => listRef.current?.scrollIntoView?.({ block: "nearest" }));
    } catch (e: any) {
      if (seq !== seqRef.current) return;               // stale 오류가 최신 결과를 지우지 않는다
      setResults([]); setSearchedKw(query); setError(e?.message ?? "검색에 실패했어요");
    } finally {
      if (seq === seqRef.current) { setSearching(false); inflightRef.current = null; }
    }
  }

  const hasResults = results.length > 0;
  return (
    <SheetOverlay className="sheet-overlay" onClick={onClose}>
      <div className="sheet member-add-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">회원 추가</div>
        <div className="perm-guide" style={{ margin: "0 0 10px" }}>
          {centerName ? <><b>{centerName}</b>에 회원을 등록해요. </> : null}
          앱에 가입한 회원을 센터에 등록해요. 아직 등록하지 않은 가입자는 <b>전체 휴대폰 번호</b>(예: 010-1234-5678)로 찾을 수 있고,
          이미 등록된 회원은 이름이나 번호 일부로 찾을 수 있어요. 등록해야 수강권 발급·예약 대상이 됩니다.
        </div>
        <div className="hol-add member-add-search" style={{ padding: 0 }}>
          <div className="member-add-search-row">
            <input aria-label="전체 휴대폰 번호 또는 회원 이름"
              ref={inputRef}
              className="input-field"
              placeholder="전체 휴대폰 번호 / 등록 회원 이름"
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
            />
            <button className="outline-action" onClick={runSearch}>검색</button>
          </div>
        </div>

        <div className="mem-detail-list" style={{ marginTop: 10 }} ref={listRef} aria-live="polite">
          {searching ? (
            <div className="daylist-empty" style={{ padding: 16 }}>검색 중...</div>
          ) : error ? (
            <div className="auth-msg error" role="alert" style={{ margin: 8 }}>{error}</div>
          ) : hasResults ? (
            <>
              <div className="member-add-count" style={{ fontSize: 12, color: "var(--ink-soft)", padding: "2px 0 6px" }}>검색 결과 {results.length}명</div>
              {results.map((r) => (
                <div key={r.profileId} className={`mem-detail-row${r.alreadyMember ? " is-registered" : ""}`}>
                  <span className="mem-detail-main">
                    {r.name}{r.phone ? ` · ${r.phone}` : ""}
                  </span>
                  {r.alreadyMember
                    ? <span className="member-add-registered" style={{ fontSize: 12, color: "var(--ink-soft)", textAlign: "right" }}>이미 이 센터에 등록된 회원이에요</span>
                    : <button className="outline-action compact" disabled={busy} onClick={() => onAdd(r.profileId)}>등록</button>}
                </div>
              ))}
            </>
          ) : searchedKw !== null ? (
            <div className="daylist-empty" style={{ padding: 16 }}>검색 결과가 없어요 — 새 회원은 전체 휴대폰 번호를 입력해야 찾을 수 있어요</div>
          ) : (
            <div className="daylist-empty" style={{ padding: 16 }}>전체 휴대폰 번호로 검색해보세요</div>
          )}
        </div>

        <div className="add-profile-actions" style={{ marginTop: 6 }}>
          <button className="ghost-btn" onClick={onClose}>닫기</button>
        </div>
      </div>
    </SheetOverlay>
  );
}
