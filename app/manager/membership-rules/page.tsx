"use client";

import Link from "next/link";
import SheetOverlay from "../../components/SheetOverlay";

/*
  매니저 - 수강권 상품 & 예약조건 설정
  - 상품(수강권 종류) 생성/삭제
  - 상품마다 "요일 + 시간 + 수업명" 조건을 여러 개 부여
  - 조건이 없으면 = 모든 수업 예약 가능
  - 예: "안무반 수강권" → 월 19:00 안무반, 수 21:00 안무반만 예약 가능
  - 수강권 설정 권한(pass.update) 필요
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Loading from "../../components/Loading";
import UiIcon from "../../components/UiIcon";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchProducts, createProduct, updateProduct, deleteProduct, deleteProducts, toggleProductSale,
  fetchRules, addRule, deleteRule, ruleToText, won, DAYS, computeSelectableSchedule,
  type Product, type ScheduleRule, type ProductVisibility,
} from "../../../lib/passes";
import { fetchExistingClassOptions, type ExistingClassOption } from "../../../lib/classes";
import { loadClassOptionsGuarded } from "../../../lib/classOptionsLoader";
import { fetchGrades, fetchMembers, type Grade, type CenterMember } from "../../../lib/members";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";
import ExpiryOptionField, { type ExpiryOptionValue } from "../../components/ExpiryOptionField";
import CountPriceEditor from "../../components/CountPriceEditor";
import CatalogSearchFilter from "../../components/CatalogSearchFilter";
import BulkSelectBar from "../../components/BulkSelectBar";
import { applyRulesToProducts, bulkRuleSummary } from "../../../lib/ruleBulk";
import { bulkDeleteConfirmMessage, bulkDeleteToast, effectiveSelection, selectAllVisible, toggleSelected } from "../../../lib/bulkSelect";
import { validateGoodsForm, goodsListLabel, draftsFromTiers, type GoodsPricingMode } from "../../../lib/goodsForm";
import { draftsToTiers, type TierDraft } from "../../../lib/selectableCount";
import { filterCatalog, uniqueGroupLabels, catalogEmptyMessage, isFilterActive, EMPTY_CATALOG_FILTER } from "../../../lib/catalogFilter";
import { pickInitialCenterId, rememberCenterId } from "../../../lib/managerCenterPref";

// 요일 선택형 수강권은 요일이 지정된 예약조건이 1개 이상 있어야 회원이 구매할 때 요일을 고를 수 있다.
const WEEKDAY_NEEDS_RULES_MESSAGE = "요일 선택형 수강권은 예약조건을 1개 이상 등록해야 회원이 구매할 수 있어요.";

export default function MembershipRulesPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const centerIdRef = useRef<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [rulesByProduct, setRulesByProduct] = useState<Record<string, ScheduleRule[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 상품 추가/수정 시트 — editingId가 있으면 수정 모드(같은 시트 재사용)
  const [prodSheet, setProdSheet] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pName, setPName] = useState("");
  const [pGroupLabel, setPGroupLabel] = useState("");
  const [pDesc, setPDesc] = useState("");
  const [pAutoDays, setPAutoDays] = useState<number[]>([]);
  const [pAutoClasses, setPAutoClasses] = useState<string[]>([]);
  const [pPrice, setPPrice] = useState("");
  const [pCount, setPCount] = useState("");
  const [pUnlimited, setPUnlimited] = useState(false);
  // 2026-10-01 — 가격 방식: 고정 횟수/고정 가격 vs 구매자가 횟수 선택(회차별 가격표). 선택 횟수는 예약조건과 독립이다
  // (group_label/요일·시간 선택/예약조건/class_allowed_products/만료/자동예약은 상품 단위로 그대로).
  const [pMode, setPMode] = useState<GoodsPricingMode>("fixed");
  const [pTiers, setPTiers] = useState<TierDraft[]>(() => draftsFromTiers([]));
  const [editWasSelectable, setEditWasSelectable] = useState(false);
  const [pExpiry, setPExpiry] = useState<ExpiryOptionValue>({ mode: "none", days: "", date: "", cutoffDay: "", allowEarlyUse: false });
  const [pLimitSale, setPLimitSale] = useState(false);
  const [pMaxQty, setPMaxQty] = useState("");
  // 2026-10-01(Batch C, C-3) — 구매 시 요일/시간 선택형 수강권. 실제 선택 후보는 이
  // 상품의 기존 예약조건(membership_schedule_rules, day_of_week가 있는 것)에서 계산되므로
  // (C-4/C-5, lib/passes.ts computeSelectableSchedule) 별도 후보 입력 UI를 새로 안 만든다.
  const [pWeekdaySelectable, setPWeekdaySelectable] = useState(false);
  const [pTimeSelectable, setPTimeSelectable] = useState(false);
  // C-15~C-17 — 수강권 복제. "복제" 버튼을 누르면 새 상품 시트를 열되 기존 값을 채워
  // 넣고, duplicateFromId에 원본을 기억해둔다 — 저장(handleCreateProduct)이 끝난 뒤에만
  // 원본의 예약조건(membership_schedule_rules)도 같이 복사한다(id/생성일/판매량/원본과의
  // FK 연결은 복사하지 않음 — 완전히 새로운 독립 상품).
  const [duplicateFromId, setDuplicateFromId] = useState<string | null>(null);
  // 쿠폰 적용 가능 여부(add_product_coupon_eligibility.sql) — 기본값 true(기존과 동일하게
  // 쿠폰 적용 가능), 매니저가 끄면 이 상품엔 어떤 쿠폰도 적용 불가.
  const [pCouponEligible, setPCouponEligible] = useState(true);
  // MWHABIT Membership Visibility Batch(2026-09-18) — 공개범위
  const [pVisType, setPVisType] = useState<ProductVisibility["type"]>("all");
  const [pVisGradeIds, setPVisGradeIds] = useState<string[]>([]);
  const [pVisMemberIds, setPVisMemberIds] = useState<string[]>([]);
  const [pVisMemberLabels, setPVisMemberLabels] = useState<Record<string, string>>({}); // center_member_id -> "이름 전화"
  const [grades, setGrades] = useState<Grade[]>([]);
  const [visMemberSearch, setVisMemberSearch] = useState("");
  const [visMemberResults, setVisMemberResults] = useState<CenterMember[]>([]);
  const [visMemberSearchBusy, setVisMemberSearchBusy] = useState(false);

  // 조건 추가 시트 (어느 상품에)
  const [ruleFor, setRuleFor] = useState<Product | null>(null);
  const [rDays, setRDays] = useState<number[]>([]);
  const [rTime, setRTime] = useState("");
  const [rTitle, setRTitle] = useState("");
  const [rPick, setRPick] = useState("");
  const [existingClasses, setExistingClasses] = useState<ExistingClassOption[]>([]);
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);
  // 다중 선택 삭제 — 평상시에는 꺼져 있고 "선택"을 눌러야 체크 UI가 나타난다.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 예약조건 일괄 설정: 선택한 수강권들(시트가 열려 있는 동안 고정). 기존 "예약조건 추가" 시트를 그대로 재사용한다.
  // 센터가 바뀌면 이전 센터 수업 목록을 즉시 버린다(늦게 도착한 이전 요청 결과도 loadClassOptions가 무시)
  useEffect(() => { centerIdRef.current = centerId; setExistingClasses([]); }, [centerId]);
  const [bulkTargets, setBulkTargets] = useState<Product[] | null>(null);
  // UX 감사(B-8) — 수강권 상품이 100개+(이름이 UUID로 끝나 구분도 안 됨)면 검색/페이징 없이
  // 전부 렌더돼 원하는 걸 찾기 어려웠다. 이름 검색 + 20개씩 "더보기"로 완화.
  // 검색/그룹 필터(2026-10-01): load()가 다시 불러와도 리셋되지 않는 컴포넌트 state — 수정/추가 후에도 유지된다.
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        if (list.length > 0) setCenterId(pickInitialCenterId(list));
        else setLoading(false);
      } catch (e: any) { setError(e.message); setLoading(false); }
    })();
  }, []);

  const activeCenter = centers.find((c) => c.id === centerId);

  useEffect(() => {
    if (!activeCenter) return;
    if (activeCenter.isOwner) { setMyPerms(null); return; }
    let cancelled = false;
    setMyPerms(null);
    fetchMyEffectivePermissionKeys(activeCenter.managerCenterId, activeCenter.roleId)
      .then((keys) => { if (!cancelled) setMyPerms(keys); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [activeCenter]);

  // 이 화면 메뉴 게이트는 pass.create지만, "예약조건"(schedule_rules)은 별도로
  // pass.update RLS를 요구한다 — 상품 CRUD와는 다른 키라 여기서 따로 체크한다.
  const canEditRules = canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, "pass.update");
  // 상품 CRUD(등록=pass.create, 수정/삭제=pass.update)는 P1-5b에서 RLS를 실제로 좁힘
  // (fix_permission_products_rooms_rls.sql) — 그 전까지는 my_managed_center_ids()만 체크했다.
  const canCreateProduct = canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, "pass.create");
  const canToggleSale = canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, "pass.sale_toggle");

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
      // MWHABIT Membership Visibility Batch — 공개범위 "특정 등급" 체크박스용 등급 목록.
      // 다른 센터 등급은 fetchGrades(centerId)가 애초에 이 센터 것만 가져오므로(RLS도
      // 이중 방어) 섞일 일 없음.
      setGrades(await fetchGrades(centerId));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  const num = (s: string) => parseInt(s.replace(/[^0-9]/g, "") || "0", 10);
  // 검색/그룹 필터 — 이미 받아 온 목록을 즉시 거를 뿐(AND, 기존 정렬 유지, 새 API 없음). group chip은 센터가 실제로 쓰는 group_label.
  const groupLabels = useMemo(() => uniqueGroupLabels(products), [products]);
  const filteredProducts = useMemo(
    () => filterCatalog(products, { ...EMPTY_CATALOG_FILTER, group: groupFilter, query }),
    [products, groupFilter, query],
  );

  function resetProdSheet() {
    setProdSheet(false); setEditingId(null);
    setPName(""); setPGroupLabel(""); setPDesc(""); setPPrice(""); setPCount("");
    setPAutoDays([]); setPAutoClasses([]);
    setPUnlimited(false); setPExpiry({ mode: "none", days: "", date: "", cutoffDay: "", allowEarlyUse: false });
    setPMode("fixed"); setPTiers(draftsFromTiers([])); setEditWasSelectable(false);
    setPLimitSale(false); setPMaxQty("");
    setPCouponEligible(true);
    setPWeekdaySelectable(false); setPTimeSelectable(false);
    setDuplicateFromId(null);
    setPVisType("all"); setPVisGradeIds([]); setPVisMemberIds([]); setPVisMemberLabels({});
    setVisMemberSearch(""); setVisMemberResults([]);
  }

  function openCreateSheet() {
    resetProdSheet();
    setProdSheet(true);
  }

  // C-15~C-17 — "복제": 기존 상품의 모든 editable 필드를 새 상품 시트에 프리필하되,
  // id/생성일/판매량/원본 FK는 옮기지 않는다(완전히 새 독립 상품). 이 시점엔 DB에 아무
  // 것도 만들지 않는다 — "추가하기"를 눌러야(handleCreateProduct) 실제로 생성된다.
  async function openDuplicateSheet(p: Product) {
    await openEditSheet(p); // 기존 "수정" 프리필 로직을 그대로 재사용(필드 목록 중복 방지)
    setEditingId(null);     // 수정이 아니라 "새로 만들기"로 전환 — 저장 시 createProduct 경로를 탐
    setEditWasSelectable(false); // 복제본은 새 상품(가격표는 프리필된 값으로 새로 저장)
    setPName(`${p.name} 복제`);
    setDuplicateFromId(p.id);
  }

  async function openEditSheet(p: Product) {
    setEditingId(p.id);
    setPName(p.name);
    setPGroupLabel(p.groupLabel ?? "");
    setPDesc(p.description ?? "");
    setPPrice(String(p.price));
    setPCount(p.totalCount ? String(p.totalCount) : "");
    setPUnlimited(p.unlimitedPass);
    setPMode(p.countSelectable ? "selectable" : "fixed");
    setPTiers(draftsFromTiers(p.countPrices));
    setEditWasSelectable(p.countSelectable);
    setPAutoDays(p.autoBookDays ?? []);
    setPAutoClasses([]);
    setPExpiry({
      mode: p.expiryMode,
      days: p.expiryDays ? String(p.expiryDays) : "",
      date: p.expiryDate ?? "",
      cutoffDay: p.rollingMonthCutoffDay != null ? String(p.rollingMonthCutoffDay) : "",
      allowEarlyUse: p.rollingMonthAllowEarlyUse ?? false,
    });
    setPLimitSale(p.maxQuantity != null);
    setPMaxQty(p.maxQuantity != null ? String(p.maxQuantity) : "");
    setPCouponEligible(p.couponEligible);
    setPWeekdaySelectable(p.weekdaySelectable);
    setPTimeSelectable(p.timeSelectable);
    // MWHABIT Membership Visibility Batch — 공개범위 프리필. "지정 회원" 칩에 이름/전화를
    // 보여주려면 center_member_id뿐 아니라 표시용 라벨도 필요해서, 이 센터의 회원
    // 목록(기존 fetchMembers 재사용)에서 매칭해 채운다.
    setPVisType(p.visibility.type);
    setPVisGradeIds(p.visibility.gradeIds);
    setPVisMemberIds(p.visibility.memberIds);
    if (p.visibility.type === "selected_members" && p.visibility.memberIds.length > 0 && centerId) {
      const all = await fetchMembers(centerId);
      const labels: Record<string, string> = {};
      for (const cm of all) {
        if (p.visibility.memberIds.includes(cm.id)) labels[cm.id] = `${cm.name}${cm.phone ? " " + cm.phone : ""}`;
      }
      setPVisMemberLabels(labels);
    } else {
      setPVisMemberLabels({});
    }
    setProdSheet(true);
  }

  function toggleVisGrade(gradeId: string) {
    setPVisGradeIds((prev) => (prev.includes(gradeId) ? prev.filter((g) => g !== gradeId) : [...prev, gradeId]));
  }

  function addVisMember(cm: CenterMember) {
    setPVisMemberIds((prev) => (prev.includes(cm.id) ? prev : [...prev, cm.id])); // 중복 선택 방지
    setPVisMemberLabels((prev) => ({ ...prev, [cm.id]: `${cm.name}${cm.phone ? " " + cm.phone : ""}` }));
  }

  function removeVisMember(centerMemberId: string) {
    setPVisMemberIds((prev) => prev.filter((id) => id !== centerMemberId));
  }

  // 회원검색 재사용(요청 2-3번 "기존 회원검색 구조 재사용") — lib/members.ts의
  // fetchMembers(keyword)를 그대로 쓴다. 새 검색 컴포넌트/쿼리를 만들지 않음.
  // 150ms 디바운스(폴리시 배치가 정착시킨 관례와 동일한 대역).
  useEffect(() => {
    if (!centerId || pVisType !== "selected_members" || !visMemberSearch.trim()) {
      setVisMemberResults([]);
      return;
    }
    const kw = visMemberSearch.trim();
    setVisMemberSearchBusy(true);
    const t = setTimeout(() => {
      fetchMembers(centerId, { keyword: kw })
        .then((rows) => setVisMemberResults(rows.slice(0, 30))) // 회원 많아도 버벅이지 않게 상한
        .catch(() => setVisMemberResults([]))
        .finally(() => setVisMemberSearchBusy(false));
    }, 150);
    return () => clearTimeout(t);
  }, [centerId, pVisType, visMemberSearch]);

  async function handleCreateProduct() {
    if (!centerId || !pName.trim()) { setError("상품 이름을 입력해주세요"); return; }
    if (pMode === "selectable") {
      const tierError = validateGoodsForm({ mode: "selectable", unlimited: pUnlimited, price: 0, totalCount: 0, tiers: pTiers });
      if (tierError) { setError(tierError); return; }
    } else {
      if (num(pPrice) <= 0) { setError("가격을 입력해주세요"); return; }
      if (!pUnlimited && num(pCount) <= 0) { setError("총 횟수를 입력해주세요 (또는 '횟수 제한 없음'을 켜주세요)"); return; }
    }
    if (pExpiry.mode === "days" && !pExpiry.days.trim()) { setError("만료까지 며칠인지 입력해주세요"); return; }
    if (pExpiry.mode === "date" && !pExpiry.date) { setError("만료일을 선택해주세요"); return; }
    if (pExpiry.mode === "rolling_month" && (!pExpiry.cutoffDay.trim() || num(pExpiry.cutoffDay) < 1 || num(pExpiry.cutoffDay) > 31)) {
      setError("며칠부터 다음 달로 칠지 1~31 사이로 입력해주세요"); return;
    }
    if (pLimitSale && num(pMaxQty) <= 0) { setError("판매 수량을 입력해주세요 (또는 '판매 수량 제한'을 꺼주세요)"); return; }
    if (pVisType === "grades" && pVisGradeIds.length === 0) { setError("공개범위를 '특정 회원등급'으로 하려면 등급을 1개 이상 선택해주세요"); return; }
    if (pVisType === "selected_members" && pVisMemberIds.length === 0) { setError("공개범위를 '지정 회원만'으로 하려면 회원을 1명 이상 선택해주세요"); return; }
    setBusy(true);
    try {
      const extra = {
        autoBookDays: pAutoDays,
        unlimitedPass: pMode === "selectable" ? false : pUnlimited,
        // 회차별 가격표(선택형)는 서버 RPC가 한 번에 교체한다. 고정으로 되돌리면(이전이 선택형이었던 경우만) 가격표 해제.
        countSelectable: pMode === "selectable",
        countPrices: pMode === "selectable" ? draftsToTiers(pTiers) : undefined,
        wasCountSelectable: editWasSelectable,
        description: pDesc.trim(),
        expiry: {
          mode: pExpiry.mode, days: pExpiry.mode === "days" ? num(pExpiry.days) : null, date: pExpiry.mode === "date" ? pExpiry.date : null,
          cutoffDay: pExpiry.mode === "rolling_month" ? num(pExpiry.cutoffDay) : null, allowEarlyUse: pExpiry.allowEarlyUse,
        },
        groupLabel: pGroupLabel.trim() || undefined,
        maxQuantity: pLimitSale ? num(pMaxQty) : null,
        visibility: { type: pVisType, gradeIds: pVisGradeIds, memberIds: pVisMemberIds } as ProductVisibility,
        couponEligible: pCouponEligible,
        weekdaySelectable: pWeekdaySelectable,
        timeSelectable: pWeekdaySelectable && pTimeSelectable,
      };
      if (editingId) {
        await updateProduct(editingId, pName.trim(), num(pPrice), num(pCount), false, extra);
        const needRules = pWeekdaySelectable && computeSelectableSchedule(rulesByProduct[editingId] ?? []).days.length === 0;
        resetProdSheet();
        showToast(needRules ? WEEKDAY_NEEDS_RULES_MESSAGE : "수강권을 수정했어요");
        await load();
        // 요일 선택형인데 요일 예약조건이 하나도 없으면 회원이 구매할 수 없다 — 바로 예약조건 추가로 연결(요일/시간은 관리자가 직접 선택)
        if (needRules) {
          const fresh = (await fetchProducts(centerId, "pass")).find((x) => x.id === editingId);
          if (fresh) await openRuleSheet(fresh);
        }
        return;
      }
      const newProductId = await createProduct(centerId, pName.trim(), num(pPrice), num(pCount), "pass", false, extra);
      // 선택한 수업이 있으면 예약조건으로 자동 등록 — 실패한 조건이 있으면 조용히 넘어가지 않고 안내한다.
      let failedRuleCount = 0;
      const fresh = !newProductId && (pAutoClasses.length > 0 || duplicateFromId) ? await fetchProducts(centerId, "pass") : null;
      // 새로 만든 상품 id를 그대로 쓴다(이름 매칭은 같은 이름 상품이 있으면 틀릴 수 있음). fresh는 id가 없을 때만 폴백.
      const made = newProductId ? { id: newProductId } : fresh?.find((x) => x.name === pName.trim());
      if (pAutoClasses.length > 0 && made) {
        for (const key of pAutoClasses) {
          const [dw, st2, ti] = key.split("|");
          try {
            await addRule(made.id, Number(dw), st2 || null, ti || null);
          } catch {
            failedRuleCount += 1;
          }
        }
      }
      // C-16 — 복제라면 원본의 예약조건(membership_schedule_rules)도 그대로 복사한다.
      // product_id만 새 상품으로 바뀔 뿐 나머지(day_of_week/start_time/class_title)는
      // 완전히 동일 — id/생성일은 당연히 새로 발급됨(addRule이 insert).
      if (duplicateFromId && made) {
        const originalRules = rulesByProduct[duplicateFromId] ?? [];
        for (const r of originalRules) {
          try {
            await addRule(made.id, r.dayOfWeek, r.startTime, r.classTitle);
          } catch {
            failedRuleCount += 1;
          }
        }
      }
      // 요일이 지정된 예약조건이 하나도 없으면(수업 자동 등록/복제 원본 포함) 요일 선택형 수강권은 구매할 수 없다.
      const createdHasDayRule = pAutoClasses.some((k) => k.split("|")[0] !== "")
        || (duplicateFromId ? (rulesByProduct[duplicateFromId] ?? []).some((r) => r.dayOfWeek !== null) : false);
      const createdNeedsRules = pWeekdaySelectable && !!made && !createdHasDayRule;
      resetProdSheet();
      if (failedRuleCount > 0) {
        setError(`상품은 추가됐지만 예약조건 ${failedRuleCount}건은 등록에 실패했어요. 조건 추가에서 다시 시도해주세요.`);
      } else if (createdNeedsRules) {
        showToast(WEEKDAY_NEEDS_RULES_MESSAGE);
      } else {
        showToast(duplicateFromId ? "상품을 복제했어요" : "상품을 추가했어요");
      }
      await load();
      if (createdNeedsRules && made) {
        const fresh = (await fetchProducts(centerId, "pass")).find((x) => x.id === made.id);
        if (fresh) await openRuleSheet(fresh);
      }
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDeleteProduct(p: Product) {
    if (!(await globalThis.appConfirm(`'${p.name}' 상품을 삭제할까요?`))) return;
    setBusy(true);
    try { await deleteProduct(p.id); showToast("삭제했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  const selectedIds = effectiveSelection(selected, filteredProducts.map((p) => p.id));
  function exitSelect() { setSelecting(false); setSelected(new Set()); }
  async function handleBulkDelete() {
    if (!centerId || selectedIds.length === 0) return;
    if (!(await globalThis.appConfirm(bulkDeleteConfirmMessage(selectedIds.length)))) return;   // 취소하면 아무것도 바꾸지 않는다
    setBusy(true);
    try {
      const n = await deleteProducts(centerId, selectedIds);
      exitSelect();
      showToast(bulkDeleteToast(n));
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleToggleSale(p: Product) {
    const next = !p.isOnSale;
    if (!(await globalThis.appConfirm(next ? `'${p.name}' 판매를 다시 시작할까요?` : `'${p.name}' 판매를 정지할까요? (기존 보유자는 영향 없어요)`))) return;
    setBusy(true);
    try { await toggleProductSale(p.id, next); showToast(next ? "판매를 재개했어요" : "판매를 정지했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  // 예약조건 추가 시트 열기(카드 버튼/요일 선택형 안내에서 공용 — 새 UI를 만들지 않고 기존 시트를 재사용한다)
  async function openRuleSheet(p: Product) {
    setRuleFor(p); setRPick(""); setRDays([]); setRTime(""); setRTitle("");
    await loadClassOptions();
  }

  // 단건/일괄 시트 공용: 시트를 열 때마다 현재 센터의 수업 목록을 새로 읽는다(race 방어는 lib/classOptionsLoader.ts — centerIdRef는 아래 effect에서만 갱신한다).
  async function loadClassOptions() {
    await loadClassOptionsGuarded({ centerId, getCurrent: () => centerIdRef.current, fetchOptions: fetchExistingClassOptions, setOptions: setExistingClasses });
  }

  async function openBulkRuleSheet() {
    const targets = products.filter((p) => selectedIds.includes(p.id));
    if (targets.length === 0) return;
    setRPick(""); setRDays([]); setRTime(""); setRTitle("");
    setBulkTargets(targets);
    await loadClassOptions();
  }

  async function handleBulkAddRules() {
    if (!bulkTargets || bulkTargets.length === 0) return;
    setBusy(true);
    try {
      const result = await applyRulesToProducts(
        bulkTargets.map((p) => ({ id: p.id, name: p.name, autoBookDays: p.autoBookDays ?? null, existingRules: rulesByProduct[p.id] ?? [] })),
        { days: rDays.length > 0 ? rDays : [null], startTime: rTime || null, classTitle: rTitle },
        addRule,
      );
      const sum = bulkRuleSummary(result);
      if (result.incompatible.length > 0) {
        // preflight 차단: DB write가 하나도 없었다. 선택/입력을 그대로 두고 사용자가 요일이나 대상을 고치게 한다.
        setError(sum.message);
      } else if (sum.hasFailure) {
        // 일부 실패: 성공처럼 닫지 않는다 — 시트를 유지하고 실패한 수강권만 남겨 다시 시도할 수 있게 한다
        setError(sum.message);
        const failedIds = new Set(result.failed.map((f) => f.id));
        setBulkTargets(bulkTargets.filter((p) => failedIds.has(p.id)));
        setSelected(failedIds);
      } else {
        setBulkTargets(null);
        exitSelect();
        showToast(sum.message);
      }
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleAddRule() {
    if (bulkTargets) { await handleBulkAddRules(); return; }
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
          <Link className="side" href="/manager" prefetch={false}>‹</Link>
          <div className="title">수강권 설정</div>
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
        <Link className="side" href="/manager" prefetch={false}>‹</Link>
        <div className="title">수강권 설정</div>
        {canCreateProduct && (
          <button className="header-action" onClick={openCreateSheet}>+ 수강권</button>
        )}
      </div>

      {centers.length > 1 && (
        <>
          <div className="menu-section-label" style={{ padding: "0 20px 4px" }}>지금 보는 센터</div>
          <div className="center-switcher">
            {centers.map((c) => (
              <button aria-pressed={c.id === centerId} key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => { setCenterId(c.id); rememberCenterId(c.id); }}>
                {c.name}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="perm-guide">
        수강권 상품마다 예약 가능한 <b>요일·시간·수업</b>을 정할 수 있어요.
        조건이 없으면 모든 수업을 예약할 수 있고, 조건을 넣으면 그에 맞는 수업만 예약돼요.
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {!loading && products.length > 0 && (
        <div className="membership-rules-filter" style={{ padding: "0 20px" }}>
          <CatalogSearchFilter
            query={query} onQuery={(q) => { setQuery(q); setVisibleCount(PAGE_SIZE); }}
            placeholder="수강권 검색" searchLabel="수강권 검색"
            groups={groupLabels} group={groupFilter} onGroup={(g) => { setGroupFilter(g); setVisibleCount(PAGE_SIZE); }}
            resultText={isFilterActive({ ...EMPTY_CATALOG_FILTER, group: groupFilter, query }) ? `검색 결과 ${filteredProducts.length}개` : null}
            sticky={false}
          />
        </div>
      )}

      {loading ? (
        <Loading />
      ) : products.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 30 }}>
          등록된 수강권이 없어요<br />
          <span style={{ fontSize: 12 }}>우측 상단 '+ 수강권'으로 추가하세요</span>
        </div>
      ) : (() => {
        const filtered = filteredProducts;
        if (filtered.length === 0) {
          return (
            <div className="catalog-empty">
              {catalogEmptyMessage(products.length, { ...EMPTY_CATALOG_FILTER, group: groupFilter, query }, "수강권")}
              <div><button type="button" className="quiet-action" onClick={() => { setQuery(""); setGroupFilter(null); }}>필터 초기화</button></div>
            </div>
          );
        }
        return (
        <div className="pass-list">
          {canEditRules && (
            <BulkSelectBar
              selecting={selecting} selectedCount={selectedIds.length} totalVisible={filtered.length} busy={busy}
              onEnter={() => setSelecting(true)} onCancel={exitSelect}
              onSelectAll={() => setSelected(selectAllVisible(filtered.map((p) => p.id)))} onClear={() => setSelected(new Set())}
              onDelete={handleBulkDelete}
              extraAction={{ label: "예약조건 일괄 설정", onClick: openBulkRuleSheet }}
            />
          )}
          {filtered.slice(0, visibleCount).map((p) => {
            const rules = rulesByProduct[p.id] ?? [];
            return (
              <div key={p.id} className={`pass-card${selecting && selected.has(p.id) ? " bulk-selected" : ""}`}>
                {selecting && (
                  <label className="bulk-check-row">
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => setSelected((prev) => toggleSelected(prev, p.id))} aria-label={`${p.name} 선택`} />
                    <span>선택</span>
                  </label>
                )}
                {/* 상품 정보(전체 폭) — 제목 / badge(줄바꿈 가능, badge 글자는 한 줄) / 가격 요약 */}
                <div className="pass-head">
                  <div className="pass-info">
                    <div className="pass-name">{p.name}</div>
                    <div className="pass-tags">
                      {p.groupLabel && <span className="pass-group-tag">{p.groupLabel}</span>}
                      {!p.isOnSale && <span className="pass-group-tag" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>판매정지</span>}
                      {/* 요일 선택형인데 요일이 지정된 예약조건이 없으면 회원 구매 화면에 선택 후보가 없어 구매할 수 없다 — 조용히 두지 않고 표시 */}
                      {p.weekdaySelectable && computeSelectableSchedule(rules).days.length === 0 && (
                        <span className="pass-group-tag" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>요일 선택형 · 예약조건 필요</span>
                      )}
                      {p.maxQuantity != null && (
                        <span className="pass-group-tag" style={p.soldCount >= p.maxQuantity ? { background: "var(--danger-soft)", color: "var(--danger)" } : undefined}>
                          {p.soldCount >= p.maxQuantity ? "매진" : `${p.maxQuantity - p.soldCount}개 남음`}
                        </span>
                      )}
                      {/* MWHABIT Membership Visibility Batch — 공개범위 subtle badge(요청
                          8번, "과도하게 복잡하지 않게"). 전체 공개는 굳이 표시 안 함(기본
                          상태라 노이즈만 됨) — 제한이 걸린 경우만 눈에 띄게 보여준다. */}
                      {p.visibility.type === "grades" && (
                        <span className="pass-group-tag" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                          {(() => {
                            const names = p.visibility.gradeIds.map((id) => grades.find((g) => g.id === id)?.name).filter(Boolean);
                            if (names.length === 0) return "등급 지정";
                            if (names.length === 1) return names[0];
                            return `${names[0]} 외 ${names.length - 1}개 등급`;
                          })()}
                        </span>
                      )}
                      {p.visibility.type === "selected_members" && (
                        <span className="pass-group-tag" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                          지정회원 {p.visibility.memberIds.length}명
                        </span>
                      )}
                      {/* 쿠폰 적용 가능은 기본값(true)이라 굳이 안 보여주고, 꺼져 있을 때만
                          눈에 띄게 — 위 공개범위 배지와 동일한 "제한이 걸린 경우만" 원칙. */}
                      {!p.couponEligible && (
                        <span className="pass-group-tag" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
                          쿠폰 적용 불가
                        </span>
                      )}
                    </div>
                    <div className="pass-sub">
                      {p.countSelectable
                        ? goodsListLabel(p)
                        : <>{won(p.price)}{p.totalCount ? ` · ${p.totalCount}회` : ""}</>}
                      {p.maxQuantity != null && ` · 판매 ${p.soldCount}/${p.maxQuantity}`}
                    </div>
                  </div>
                </div>
                {/* 액션은 정보 아래 별도 행(정보와 같은 행에서 폭을 다투지 않음) */}
                {(canEditRules || canToggleSale) && (
                  <div className="pass-actions">
                      {canToggleSale && (
                        <button className="quiet-action" disabled={busy} onClick={() => handleToggleSale(p)}>
                          {p.isOnSale ? "판매정지" : "판매재개"}
                        </button>
                      )}
                      {canEditRules && (
                        <>
                          <button className="quiet-action" disabled={busy} onClick={() => openEditSheet(p)}>수정</button>
                          {canCreateProduct && (
                            <button className="quiet-action" disabled={busy} onClick={() => openDuplicateSheet(p)}>복제</button>
                          )}
                          <button className="quiet-action danger" disabled={busy} onClick={() => handleDeleteProduct(p)}>삭제</button>
                        </>
                      )}
                  </div>
                )}

                {/* 요일 선택형인데 요일 예약조건이 0개면 회원이 구매할 수 없다 — 이유를 설명하고 기존 예약조건 추가 시트로 바로 연결 */}
                {p.weekdaySelectable && computeSelectableSchedule(rules).days.length === 0 && (
                  <div className="perm-guide is-warning weekday-needs-rules" role="alert">
                    <b>회원이 구매할 수 없는 상태예요.</b> {WEEKDAY_NEEDS_RULES_MESSAGE}
                    {canEditRules && (
                      <div><button type="button" className="quiet-action" disabled={busy} onClick={() => openRuleSheet(p)}>예약조건 추가</button></div>
                    )}
                  </div>
                )}
                <button className="pass-rules-toggle" onClick={() => setExpandedProducts((prev) => {
                  const next = new Set(prev); if (next.has(p.id)) next.delete(p.id); else next.add(p.id); return next;
                })}>
                  <span>예약 조건 {rules.length}개</span><b>{expandedProducts.has(p.id) ? "접기" : "보기"}⌄</b>
                </button>
                {expandedProducts.has(p.id) && <div className="pass-rules">
                  {rules.length === 0 ? (
                    <div className="pass-norule">모든 수업 예약 가능 (조건 없음)</div>
                  ) : (
                    rules.map((r) => (
                      <div key={r.id} className="pass-rule">
                        <span className="pass-rule-text">{ruleToText(r)}</span>
                        {canEditRules && (
                          <button className="pass-rule-del" disabled={busy} onClick={() => handleDeleteRule(r.id)} aria-label="규칙 삭제"><UiIcon name="close" size={13} /></button>
                        )}
                      </div>
                    ))
                  )}
                </div>}

                {canEditRules && (
                  <button className="prog-add-sub-btn" onClick={() => openRuleSheet(p)}>
                    예약조건 추가
                  </button>
                )}
              </div>
            );
          })}
          {filtered.length > visibleCount && (
            <button className="ghost-btn" style={{ margin: "12px 20px" }} onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
              더보기 ({filtered.length - visibleCount}건 더 있음)
            </button>
          )}
          <div style={{ height: 40 }} />
        </div>
        );
      })()}

      {/* 상품 추가/수정 시트 */}
      {prodSheet && (
        <SheetOverlay className="sheet-overlay" onClick={resetProdSheet}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{duplicateFromId ? "수강권 복제" : editingId ? "수강권 수정" : "수강권 추가"}</div>
            {duplicateFromId && (
              <div className="perm-guide" style={{ margin: "0 0 8px" }}>기존 수강권 설정을 복사했어요. 원하는 부분만 바꾼 뒤 추가해주세요.</div>
            )}
            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>상품 이름</div>
            <input aria-label="상품 이름" className="input-field" placeholder="예: 안무반 수강권" value={pName} onChange={(e) => setPName(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
              그룹명 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 선택, 회원 화면에서 이 이름으로 묶여 보여요</span>
            </div>
            <input aria-label="수강권 그룹명" className="input-field" list="pass-group-label-options" placeholder="예: 요일고정, 자유이용" value={pGroupLabel} onChange={(e) => setPGroupLabel(e.target.value)} />
            <datalist id="pass-group-label-options">
              {Array.from(new Set(products.map((p) => p.groupLabel).filter((g): g is string => !!g))).map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
              설명 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 선택, 회원이 이름을 누르면 보여요</span>
            </div>
            <textarea aria-label="예: 화 19:00 안무반 전용 수강권이에요" className="input-field" style={{ minHeight: 60, resize: "vertical", lineHeight: 1.5 }}
              placeholder="예: 화 19:00 안무반 전용 수강권이에요" value={pDesc} onChange={(e) => setPDesc(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>가격 방식</div>
            <div className="mem-filters" style={{ padding: 0 }}>
              <button type="button" aria-pressed={pMode === "fixed"} className={`filter-chip ${pMode === "fixed" ? "on" : ""}`}
                onClick={() => setPMode("fixed")}>고정 횟수/고정 가격</button>
              <button type="button" aria-pressed={pMode === "selectable"} className={`filter-chip ${pMode === "selectable" ? "on" : ""}`}
                onClick={() => { setPMode("selectable"); setPUnlimited(false); }}>구매자가 횟수 선택</button>
            </div>
            {pMode === "fixed" ? (
              <>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>가격</div>
                <input aria-label="가격" inputMode="numeric" className="input-field" placeholder="0" value={pPrice} onChange={(e) => setPPrice(e.target.value)} />
                <div className="set-row" style={{ padding: "12px 0 6px", borderBottom: "none" }}>
                  <div className="set-label">횟수 제한 없음 (무제한)</div>
                  <button className={`switch ${pUnlimited ? "on" : ""}`} onClick={() => setPUnlimited(!pUnlimited)}>
                    <span className="knob" />
                  </button>
                </div>
                {!pUnlimited && (
                  <>
                    <div className="menu-section-label" style={{ padding: "6px 0 6px" }}>총 횟수</div>
                    <input aria-label="총 횟수" inputMode="numeric" className="input-field" placeholder="예: 8" value={pCount} onChange={(e) => setPCount(e.target.value)} />
                  </>
                )}
              </>
            ) : (
              <CountPriceEditor rows={pTiers} onChange={setPTiers} disabled={busy} />
            )}

            {/* 판매 수량 제한 — "총 횟수"(수강권 1개당 사용 가능 횟수)와는 별개로, 이 상품
                자체를 몇 개까지만 판매할지(예: 정원 10명짜리 특강이면 10개) 설정 */}
            <div className="set-row" style={{ padding: "12px 0 6px", borderBottom: "none" }}>
              <div className="set-label">판매 수량 제한<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>특강 등 — 정한 개수만큼 팔리면 자동으로 판매가 멈춰요</span></div>
              <button className={`switch ${pLimitSale ? "on" : ""}`} onClick={() => setPLimitSale(!pLimitSale)}>
                <span className="knob" />
              </button>
            </div>
            {pLimitSale && (
              <>
                <input aria-label="판매 수량" inputMode="numeric" className="input-field" placeholder="예: 10" value={pMaxQty} onChange={(e) => setPMaxQty(e.target.value)} />
                {editingId && (() => {
                  const cur = products.find((x) => x.id === editingId);
                  if (!cur) return null;
                  return (
                    <div className="perm-guide" style={{ margin: "4px 0 0" }}>
                      지금까지 <b>{cur.soldCount}개</b> 판매됐어요. 이보다 적은 수로 줄이면 바로 추가 판매가 막혀요.
                    </div>
                  );
                })()}
              </>
            )}

            {/* 횟수와 별개로 기간을 걸 수 있음 — 예: 무제한+한 달 기간 = 기간권 효과,
                5회권+한 달 기간 = 5회 다 안 써도 한 달 뒤 자동 만료(사용자 요청, 2026-09-01) */}
            <ExpiryOptionField value={pExpiry} onChange={setPExpiry} />

            {/* 쿠폰 적용 가능 여부(add_product_coupon_eligibility.sql) — 끄면 이 상품엔
                어떤 쿠폰(모든 수강권 대상이든 이 상품을 직접 지정한 쿠폰이든)도 적용 못
                한다. 쿠폰 쪽 설정보다 이 값이 항상 우선하고, 결제 확정 시점에 서버가
                다시 강제한다(UI에서만 막는 게 아님). */}
            <div className="set-row" style={{ padding: "12px 0 6px", borderBottom: "none" }}>
              <div className="set-label">쿠폰 적용 가능<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>끄면 이 상품엔 어떤 쿠폰도 적용할 수 없어요</span></div>
              <button className={`switch ${pCouponEligible ? "on" : ""}`} onClick={() => setPCouponEligible(!pCouponEligible)}>
                <span className="knob" />
              </button>
            </div>

            {/* MWHABIT Membership Visibility Batch(2026-09-18) — 공개 범위. 최종 강제는
                항상 서버(orders INSERT RLS + 결제 확정 RPC)에서 다시 하므로, 여기서
                뭘 고르든 UI 실수만으로 자격 없는 회원에게 판매되지는 않는다. */}
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>공개 범위</div>
            <div className="vis-type-options" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {([
                { v: "all", label: "전체 회원" },
                { v: "grades", label: "특정 회원등급" },
                { v: "selected_members", label: "지정 회원만" },
              ] as const).map((opt) => (
                <label key={opt.v} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="radio" name="pVisType" checked={pVisType === opt.v} onChange={() => setPVisType(opt.v)} />
                  {opt.label}
                </label>
              ))}
            </div>

            {pVisType === "grades" && (
              <div style={{ marginTop: 8 }}>
                {grades.length === 0 ? (
                  <div className="perm-guide">이 센터에 등록된 회원등급이 없어요. 회원 관리에서 등급을 먼저 만들어주세요.</div>
                ) : (
                  <div className="mem-filters" style={{ padding: 0, flexWrap: "wrap" }}>
                    {grades.map((g) => (
                      <button aria-pressed={pVisGradeIds.includes(g.id)}
                        key={g.id}
                        type="button"
                        className={`filter-chip ${pVisGradeIds.includes(g.id) ? "on" : ""}`}
                        style={g.color ? { borderColor: g.color } : undefined}
                        onClick={() => toggleVisGrade(g.id)}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {pVisType === "selected_members" && (
              <div style={{ marginTop: 8 }}>
                <input aria-label="회원 이름 또는 전화번호 검색"
                  className="input-field"
                  placeholder="회원 이름 또는 전화번호 검색"
                  value={visMemberSearch}
                  onChange={(e) => setVisMemberSearch(e.target.value)}
                />
                {visMemberSearchBusy && <div className="perm-guide" style={{ margin: "4px 0 0" }}>검색 중…</div>}
                {visMemberResults.length > 0 && (
                  <div className="vis-member-results" style={{ marginTop: 6, maxHeight: 180, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                    {visMemberResults.map((cm) => (
                      <button
                        key={cm.id}
                        type="button"
                        className="quiet-action"
                        style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "8px 10px", textAlign: "left" }}
                        disabled={pVisMemberIds.includes(cm.id)}
                        onClick={() => { addVisMember(cm); setVisMemberSearch(""); setVisMemberResults([]); }}
                      >
                        <span>{cm.name}</span>
                        <span style={{ color: "var(--text-dim)" }}>{cm.phone ?? ""}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="perm-guide" style={{ margin: "8px 0 4px" }}>선택된 회원 {pVisMemberIds.length}명</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {pVisMemberIds.map((id) => (
                    <span key={id} className="filter-chip on" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {pVisMemberLabels[id] ?? id}
                      <button type="button" onClick={() => removeVisMember(id)} aria-label="선택 해제" style={{ background: "none", border: "none", cursor: "pointer", color: "inherit" }}>×</button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
              요일반 수강권 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 선택 시 회원이 자동예약을 고를 수 있어요</span>
            </div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {["일", "월", "화", "수", "목", "금", "토"].map((w, i) => (
                <button aria-pressed={pAutoDays.includes(i)} key={i} className={`filter-chip ${pAutoDays.includes(i) ? "on" : ""}`}
                  onClick={() => setPAutoDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}>
                  {w}
                </button>
              ))}
            </div>
            <div className="perm-guide" style={{ margin: "4px 0 0" }}>
              예) 화요일 4회권이면 <b>화</b>만 선택. 아무것도 안 고르면 일반 수강권이에요.
              {!editingId && " 여기서는 이미 등록된 수업 중에서만 골라요 — 더 자유롭게 조건을 걸고 싶으면(예: 특정 시간대만, 아직 안 만든 수업) 만든 뒤 카드의 \"예약조건 추가\"를 따로 이용하세요."}
            </div>

            {!editingId && pAutoDays.length > 0 && (() => {
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

            {/* 2026-10-01(Batch C, C-1~C-3) — 구매 시 요일/시간 선택형 수강권. 위
                "요일반 수강권"(auto_book_days, 자동예약 트리거)과는 완전히 다른 기능이라
                이름/문구를 분명히 구분했다 — 이건 "회원이 구매할 때 고르고, 그 요일/시간
                수업만 예약할 수 있게 제한"하는 기능(자동으로 대신 예약해주지 않음). 실제
                선택 후보는 이 상품에 등록된 예약조건(요일이 지정된 것)에서 계산돼서 여기서
                새로 입력받지 않는다 — 조건이 아직 없으면 저장 후 아래 "예약조건 추가"로
                등록하라고 안내한다. */}
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>구매 시 요일/시간 선택</div>
            <div className="set-row" style={{ padding: "6px 0", borderBottom: "none" }}>
              <div className="set-label">구매할 때 수강 요일 선택<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>회원이 구매할 때 이 수강권으로 이용할 요일을 선택해요.</span></div>
              <button className={`switch ${pWeekdaySelectable ? "on" : ""}`} onClick={() => setPWeekdaySelectable(!pWeekdaySelectable)}>
                <span className="knob" />
              </button>
            </div>
            {pWeekdaySelectable && (
              <div className="set-row" style={{ padding: "6px 0", borderBottom: "none" }}>
                <div className="set-label">시간도 함께 선택<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>요일을 고른 뒤 이용할 수업 시간까지 선택해요.</span></div>
                <button className={`switch ${pTimeSelectable ? "on" : ""}`} onClick={() => setPTimeSelectable(!pTimeSelectable)}>
                  <span className="knob" />
                </button>
              </div>
            )}
            {pWeekdaySelectable && (() => {
              const candidateRules = editingId ? (rulesByProduct[editingId] ?? []) : [];
              const schedule = computeSelectableSchedule(candidateRules);
              return schedule.days.length === 0 ? (
                <div className="perm-guide" style={{ margin: "4px 0 0" }}>
                  아직 요일이 지정된 예약조건이 없어요 — {editingId ? "아래" : "저장한 뒤"} "예약조건 추가"에서
                  회원이 고를 수 있는 요일(과 시간)을 먼저 등록해주세요(예: 월 16:00, 월 20:00, 수 16:00).
                </div>
              ) : (
                <div className="perm-guide" style={{ margin: "4px 0 0" }}>
                  회원이 고를 수 있는 요일: {schedule.days.map((d) => DAYS[d]).join(", ")}
                  {pTimeSelectable && ` (시간: ${[...new Set(Object.values(schedule.timesByDay).flat())].join(", ") || "미지정"})`}
                </div>
              );
            })()}

            {/* 2026-10-01(B-7) — 취소/저장을 정확히 반반 대신 약 3:7 비율로(저장 쪽이 주 행동) */}
            <div className="add-profile-actions sheet-actions-37" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={resetProdSheet}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleCreateProduct}>{editingId ? "저장" : "추가"}</button>
            </div>
          </div>
        </SheetOverlay>
      )}

      {/* 조건 추가 시트 */}
      {(ruleFor || bulkTargets) && (
        <SheetOverlay className="sheet-overlay" onClick={() => { setRuleFor(null); setBulkTargets(null); }}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{bulkTargets ? `선택한 ${bulkTargets.length}개 수강권 예약조건 일괄 설정` : `${ruleFor!.name} 조건 추가`}</div>
            {bulkTargets && <div className="perm-guide" style={{ margin: "0 0 8px" }}>선택한 <b>{bulkTargets.length}개</b> 수강권 모두에 아래 조건이 <b>추가</b>돼요(이미 같은 조건이 있으면 중복 없이 그대로 두고, 요일 고정 수강권이 선택한 요일을 모두 받을 수 없으면 아무것도 적용하지 않아요).</div>}
            {ruleFor && ruleFor.weekdaySelectable && computeSelectableSchedule(rulesByProduct[ruleFor.id] ?? []).days.length === 0 && (
              <div className="perm-guide is-warning" style={{ margin: "0 0 8px" }}>
                {WEEKDAY_NEEDS_RULES_MESSAGE} 회원이 고를 요일(과 시간)을 직접 선택해 추가해주세요.
              </div>
            )}

            {(() => {
              const lockDays = bulkTargets ? [] : (ruleFor!.autoBookDays ?? []);
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
              요일 {!bulkTargets && (ruleFor!.autoBookDays ?? []).length > 0 ? "(요일반이라 고정)" : "(여러 개 선택 가능, 안 고르면 모든 요일)"}
            </div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {!bulkTargets && (ruleFor!.autoBookDays ?? []).length > 0 ? (
                (ruleFor!.autoBookDays ?? []).map((d) => (
                  <button key={d} className="filter-chip on" disabled>{DAYS[d]}</button>
                ))
              ) : (
                <>
                  <button aria-pressed={rDays.length === 0} className={`filter-chip ${rDays.length === 0 ? "on" : ""}`} onClick={() => setRDays([])}>모든 요일</button>
                  {DAYS.map((d, i) => (
                    <button aria-pressed={rDays.includes(i)} key={i} className={`filter-chip ${rDays.includes(i) ? "on" : ""}`} onClick={() => setRDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}>{d}</button>
                  ))}
                </>
              )}
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>시작 시간 (비우면 모든 시간)</div>
            <input type="time" className="input-field" value={rTime} onChange={(e) => setRTime(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>수업명 포함 (비우면 모든 수업)</div>
            <input aria-label="수업명 포함 조건" className="input-field" placeholder="예: 안무반" value={rTitle} onChange={(e) => setRTitle(e.target.value)} />

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => { setRuleFor(null); setBulkTargets(null); }}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleAddRule}>{bulkTargets ? `${bulkTargets.length}개에 추가` : "추가"}</button>
            </div>
          </div>
        </SheetOverlay>
      )}
    </div>
  );
}
