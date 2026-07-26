"use client";

/*
  매니저 - 수강권 상품 & 예약조건 설정
  - 상품(수강권 종류) 생성/삭제
  - 상품마다 "요일 + 시간 + 수업명" 조건을 여러 개 부여
  - 조건이 없으면 = 모든 수업 예약 가능
  - 예: "안무반 수강권" → 월 19:00 안무반, 수 21:00 안무반만 예약 가능
  - 수강권 관리 권한(pass.update) 필요
*/

import { useCallback, useEffect, useState } from "react";
import ManagerNav from "../../components/ManagerNav";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchProducts, createProduct, deleteProduct,
  fetchRules, addRule, deleteRule, ruleToText, won, DAYS,
  type Product, type ScheduleRule,
} from "../../../lib/passes";
import { fetchExistingClassOptions, type ExistingClassOption } from "../../../lib/classes";

export default function MembershipRulesPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [rulesByProduct, setRulesByProduct] = useState<Record<string, ScheduleRule[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 상품 추가 시트
  const [prodSheet, setProdSheet] = useState(false);
  const [pName, setPName] = useState("");
  const [pAutoDays, setPAutoDays] = useState<number[]>([]);
  const [pAutoClasses, setPAutoClasses] = useState<string[]>([]);
  const [pPrice, setPPrice] = useState("");
  const [pCount, setPCount] = useState("");

  // 조건 추가 시트 (어느 상품에)
  const [ruleFor, setRuleFor] = useState<Product | null>(null);
  const [rDays, setRDays] = useState<number[]>([]);
  const [rTime, setRTime] = useState("");
  const [rTitle, setRTitle] = useState("");
  const [rPick, setRPick] = useState("");
  const [existingClasses, setExistingClasses] = useState<ExistingClassOption[]>([]);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

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
      const prods = await fetchProducts(centerId);
      setProducts(prods);
      // 각 상품의 조건 로드
      const map: Record<string, ScheduleRule[]> = {};
      await Promise.all(prods.map(async (p) => { map[p.id] = await fetchRules(p.id); }));
      setRulesByProduct(map);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  const num = (s: string) => parseInt(s.replace(/[^0-9]/g, "") || "0", 10);

  async function handleCreateProduct() {
    if (!centerId || !pName.trim()) { setError("상품 이름을 입력해주세요"); return; }
    setBusy(true);
    try {
      await createProduct(centerId, pName.trim(), num(pPrice), num(pCount), "pass", false, { autoBookDays: pAutoDays });
      // 선택한 수업이 있으면 예약조건으로 자동 등록
      if (pAutoClasses.length > 0) {
        const fresh = await fetchProducts(centerId, "pass");
        const made = fresh.find((x) => x.name === pName.trim());
        if (made) {
          for (const key of pAutoClasses) {
            const [dw, st2, ti] = key.split("|");
            try { await addRule(made.id, Number(dw), st2 || null, ti || null); } catch { /* 무시 */ }
          }
        }
      }
      setPName(""); setPPrice(""); setPCount(""); setPAutoDays([]); setPAutoClasses([]);
      setProdSheet(false);
      showToast("상품을 추가했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDeleteProduct(p: Product) {
    if (!confirm(`'${p.name}' 상품을 삭제할까요?`)) return;
    setBusy(true);
    try { await deleteProduct(p.id); showToast("삭제했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleAddRule() {
    if (!ruleFor) return;
    setBusy(true);
    try {
      const days: (number | null)[] = rDays.length > 0 ? rDays : [null];
      for (const d of days) {
        await addRule(ruleFor.id, d, rTime || null, rTitle.trim() || null);
      }
      setRDays([]); setRTime(""); setRTitle("");
      setRuleFor(null);
      showToast("조건을 추가했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDeleteRule(id: string) {
    setBusy(true);
    try { await deleteRule(id); showToast("조건을 삭제했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">수강권 관리</div>
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
        <div className="title">수강권 관리</div>
        <button className="header-action" onClick={() => setProdSheet(true)}>+ 수강권</button>
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
        수강권 상품마다 예약 가능한 <b>요일·시간·수업</b>을 정할 수 있어요.
        조건이 없으면 모든 수업을 예약할 수 있고, 조건을 넣으면 그에 맞는 수업만 예약돼요.
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : products.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 30 }}>
          등록된 수강권이 없어요<br />
          <span style={{ fontSize: 12 }}>우측 상단 '+ 수강권'으로 추가하세요</span>
        </div>
      ) : (
        <div className="pass-list">
          {products.map((p) => {
            const rules = rulesByProduct[p.id] ?? [];
            return (
              <div key={p.id} className="pass-card">
                <div className="pass-head">
                  <div>
                    <div className="pass-name">{p.name}</div>
                    <div className="pass-sub">
                      {won(p.price)}{p.totalCount ? ` · ${p.totalCount}회` : ""}
                    </div>
                  </div>
                  <button className="text-btn danger" disabled={busy} onClick={() => handleDeleteProduct(p)}>삭제</button>
                </div>

                <div className="pass-rules">
                  {rules.length === 0 ? (
                    <div className="pass-norule">모든 수업 예약 가능 (조건 없음)</div>
                  ) : (
                    rules.map((r) => (
                      <div key={r.id} className="pass-rule">
                        <span className="pass-rule-text">{ruleToText(r)}</span>
                        <button className="pass-rule-del" disabled={busy} onClick={() => handleDeleteRule(r.id)}>✕</button>
                      </div>
                    ))
                  )}
                </div>

                <button className="prog-add-sub-btn" onClick={async () => { setRuleFor(p); setRPick(""); setRDays([]); setRTime(""); setRTitle(""); if (centerId) { try { setExistingClasses(await fetchExistingClassOptions(centerId)); } catch { setExistingClasses([]); } } }}>
                  + 예약조건 추가
                </button>
              </div>
            );
          })}
          <div style={{ height: 40 }} />
        </div>
      )}

      {/* 상품 추가 시트 */}
      {prodSheet && (
        <div className="sheet-overlay" onClick={() => setProdSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">수강권 추가</div>
            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>상품 이름</div>
            <input className="input-field" placeholder="예: 안무반 수강권" value={pName} onChange={(e) => setPName(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>가격</div>
            <input inputMode="numeric" className="input-field" placeholder="0" value={pPrice} onChange={(e) => setPPrice(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>총 횟수</div>
            <input inputMode="numeric" className="input-field" placeholder="예: 8" value={pCount} onChange={(e) => setPCount(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
              요일반 수강권 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 선택 시 회원이 자동예약을 고를 수 있어요</span>
            </div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {["일", "월", "화", "수", "목", "금", "토"].map((w, i) => (
                <button key={i} className={`filter-chip ${pAutoDays.includes(i) ? "on" : ""}`}
                  onClick={() => setPAutoDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}>
                  {w}
                </button>
              ))}
            </div>
            <div className="perm-guide" style={{ margin: "4px 0 0" }}>
              예) 화요일 4회권이면 <b>화</b>만 선택. 아무것도 안 고르면 일반 수강권이에요.
            </div>

            {pAutoDays.length > 0 && (() => {
              const dayClasses = existingClasses.filter((c) => pAutoDays.includes(c.dayOfWeek));
              return (
                <>
                  <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
                    수강 가능한 수업 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 안 고르면 그 요일 전체</span>
                  </div>
                  {dayClasses.length === 0 ? (
                    <div className="daylist-empty" style={{ padding: 12 }}>
                      선택한 요일에 등록된 수업이 없어요
                    </div>
                  ) : (
                    <div className="copy-select-list" style={{ maxHeight: 160 }}>
                      {dayClasses.map((c, i) => {
                        const key = `${c.dayOfWeek}|${c.startTime}|${c.title}`;
                        return (
                          <label key={i} className="copy-select-row">
                            <input type="checkbox" checked={pAutoClasses.includes(key)}
                              onChange={() => setPAutoClasses((prev) =>
                                prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key])} />
                            <span className="copy-select-main">
                              <b>{c.title}</b>
                              <span className="copy-select-sub">{DAYS[c.dayOfWeek]}요일 {c.startTime}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()}

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => { setProdSheet(false); setPAutoDays([]); setPAutoClasses([]); }}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleCreateProduct}>추가</button>
            </div>
          </div>
        </div>
      )}

      {/* 조건 추가 시트 */}
      {ruleFor && (
        <div className="sheet-overlay" onClick={() => setRuleFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{ruleFor.name} 조건 추가</div>

            {(() => {
              const lockDays = ruleFor.autoBookDays ?? [];
              const isWeekdayPass = lockDays.length > 0;
              const pickable = isWeekdayPass
                ? existingClasses.filter((c) => lockDays.includes(c.dayOfWeek))
                : existingClasses;
              return (
                <>
                  {isWeekdayPass && (
                    <div className="perm-guide" style={{ margin: "0 0 12px" }}>
                      이 수강권은 <b>{lockDays.map((d) => DAYS[d]).join("·")}요일반</b>이에요.
                      해당 요일 수업만 지정할 수 있어요.
                    </div>
                  )}
                  {pickable.length > 0 ? (
                    <>
                      <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>
                        {isWeekdayPass ? "이 요일의 수업에서 고르기" : "기존 수업에서 고르기 (선택하면 자동 입력)"}
                      </div>
                      <select className="input-field" value={rPick} onChange={(e) => {
                        setRPick(e.target.value);
                        const idx = Number(e.target.value);
                        if (isNaN(idx)) return;
                        const c = pickable[idx];
                        if (c) { setRDays([c.dayOfWeek]); setRTime(c.startTime); setRTitle(c.title); }
                      }}>
                        <option value="">직접 입력하기</option>
                        {pickable.map((c, i) => (
                          <option key={i} value={i}>{DAYS[c.dayOfWeek]} {c.startTime} · {c.title}</option>
                        ))}
                      </select>
                    </>
                  ) : isWeekdayPass ? (
                    <div className="daylist-empty" style={{ padding: 14 }}>
                      {lockDays.map((d) => DAYS[d]).join("·")}요일에 등록된 수업이 없어요
                    </div>
                  ) : null}
                </>
              );
            })()}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
              요일 {(ruleFor.autoBookDays ?? []).length > 0 ? "(요일반이라 고정)" : "(여러 개 선택 가능, 안 고르면 모든 요일)"}
            </div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {(ruleFor.autoBookDays ?? []).length > 0 ? (
                (ruleFor.autoBookDays ?? []).map((d) => (
                  <button key={d} className="filter-chip on" disabled>{DAYS[d]}</button>
                ))
              ) : (
                <>
                  <button className={`filter-chip ${rDays.length === 0 ? "on" : ""}`} onClick={() => setRDays([])}>모든 요일</button>
                  {DAYS.map((d, i) => (
                    <button key={i} className={`filter-chip ${rDays.includes(i) ? "on" : ""}`} onClick={() => setRDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}>{d}</button>
                  ))}
                </>
              )}
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>시작 시간 (비우면 모든 시간)</div>
            <input type="time" className="input-field" value={rTime} onChange={(e) => setRTime(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>수업명 포함 (비우면 모든 수업)</div>
            <input className="input-field" placeholder="예: 안무반" value={rTitle} onChange={(e) => setRTitle(e.target.value)} />

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setRuleFor(null)}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleAddRule}>추가</button>
            </div>
          </div>
        </div>
      )}
      <ManagerNav />
    </div>
  );
}
