"use client";

import MemberAddSheet from "../../components/MemberAddSheet";
import SheetOverlay from "../../components/SheetOverlay";

/*
  매니저 - 회원 관리 화면
  - 센터 선택 → 회원 목록 (등급/상태 필터 + 이름·전화 검색)
  - 회원 등급 부여, 메모 작성 (메모는 회원에게 안 보임)
  - 엑셀(CSV) 내보내기: 내보낼 항목 선택
*/

import { Suspense, useCallback, useEffect, useState, useRef } from "react";
import Loading from "../../components/Loading";
import { useSearchParams } from "next/navigation";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchMembers, fetchGrades, createGrade, deleteGrade,
  updateMemberGrade, updateMemberMemo, updateMemberAddress, updateMemberStatus, syncMembersFromReservations,
  membersToCsv, fetchMemberDetail, addMemberToCenter, sendAlimtalkToMembers, extendMembershipExpiry,
  type CenterMember, type Grade, type MemberDetailData,
} from "../../../lib/members";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";
import { getMyAccountId } from "../../../lib/authAccount";
import {
  fetchMemberMemos, createMemberMemo, updateMemberMemoEntry, deleteMemberMemoEntry, type MemberMemo,
} from "../../../lib/memberMemos";
import { fetchCenterSubscription } from "../../../lib/centerSubscription";
import { fetchGrantableProducts, grantProductToMember, won, type GrantInput, type SaleProduct } from "../../../lib/sales";
import { countOptionLabel, priceSummary, tierPriceFor } from "../../../lib/selectableCount";
import { defaultGrantPrice, grantBlockReason, grantCountOptions, grantSheetTitle, holdingLabel, productNeedsSize, suggestGrantSize, type GrantKind } from "../../../lib/memberGrant";
import {
  EXPIRY_PERMISSION_KEY, MAX_REASON_LENGTH, QUICK_EXTEND_DAYS, extensionConfirmMessage, extensionSuccessMessage, formatDotDate, isExtendablePass, previewExtension,
  type ExtendMode,
} from "../../../lib/membershipExpiry";
import { fetchPurchaseScheduleOptions } from "../../../lib/center";
import { DAYS, type SelectableSchedule } from "../../../lib/passes";
import AlimtalkComposer, {
  emptyAlimtalkBlocks, flattenAlimtalkBlocks, hasAlimtalkContent, type AlimtalkBlock,
} from "../../components/AlimtalkComposer";

import { toUserMessage } from "../../../lib/userError";
const RES_STATUS: Record<string, string> = {
  confirmed: "확정", waitlisted: "대기", cancelled: "취소", attended: "출석", no_show: "노쇼",
};
const SALE_LABEL: Record<string, string> = {
  new: "신규", renew: "재결제", trial: "체험", upgrade: "업그레이드", refund: "환불", unpaid_pay: "미수금", transfer_fee: "양도",
  service: "서비스",
};

const STATUS_LABEL: Record<string, string> = {
  active: "이용중", expired: "만료", dormant: "휴면",
};

const CSV_COLUMNS = [
  { key: "name", label: "이름" },
  { key: "grade", label: "등급" },
  { key: "phone", label: "전화번호" },
  { key: "registeredAt", label: "등록일" },
  { key: "lastAttendedAt", label: "최근출석일" },
  { key: "appLinked", label: "앱연결여부" },
  { key: "status", label: "상태" },
  { key: "passName", label: "수강권명" },
  { key: "remainingCount", label: "잔여횟수" },
  { key: "expiresAt", label: "만료일" },
  { key: "memo", label: "메모" },
];

const GRADE_COLORS = ["#E86A5E", "#F0B429", "#EC8FA8", "#5B8DEF", "#3E9C8C", "#8B6BB1"];

export default function MembersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <MembersContent />
    </Suspense>
  );
}

function MembersContent() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [members, setMembers] = useState<CenterMember[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [loading, setLoading] = useState(true);
  // 릴리스 폴리시 배치 8차(2026-09-17), 3-7 검색 성능 감사 결과: 예전엔 keystroke마다
  // setLoading(true)를 즉시 호출해 목록 영역 전체가 <Loading/> 풀스크린 스켈레톤으로
  // 매번 바뀌었다(검색 중 이전 결과가 안 보임) — searching은 그 대신 쓰는 가벼운 표시용
  // state로, 목록(members)은 새 결과가 도착하기 전까지 그대로 유지한다.
  const [listSearching, setListSearching] = useState(false);
  // 같은 이유로 "센터를 처음 선택했을 때"만 풀스크린 로딩을 보여주고, 그 뒤 필터/검색
  // 변경으로 다시 fetch할 때는 loading을 다시 켜지 않는다.
  const hasLoadedRef = useRef(false);
  // stale response 방지 — 빠르게 입력하면 늦게 시작한 요청이 먼저 끝날 수 있어, 항상
  // "가장 마지막으로 시작한 요청"의 결과만 반영한다(이전 검색어의 응답이 최신 검색어
  // 결과를 덮어쓰지 않게).
  const requestSeqRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 필터
  const [gradeFilter, setGradeFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [searchField, setSearchField] = useState<"all" | "name" | "phone" | "address">("all");

  // 시트
  const [detail, setDetail] = useState<CenterMember | null>(null);
  const [detailData, setDetailData] = useState<MemberDetailData | null>(null);
  const [detailTab, setDetailTab] = useState<"info" | "reservations" | "progress" | "payments">("info");
  const [showAllPasses, setShowAllPasses] = useState(false);
  const [showAllGoods, setShowAllGoods] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [memoText, setMemoText] = useState("");
  const [addressText, setAddressText] = useState("");
  // 회원 메모 (member_memos, 다중 작성자) — 특이사항(memoText)과는 별개 기능
  const [memberMemos, setMemberMemos] = useState<MemberMemo[]>([]);
  const [memberMemoInput, setMemberMemoInput] = useState("");
  const [editingMemberMemoId, setEditingMemberMemoId] = useState<string | null>(null);
  const [editingMemberMemoContent, setEditingMemberMemoContent] = useState("");
  const [memberMemoBusy, setMemberMemoBusy] = useState(false);
  const [myAccountId, setMyAccountId] = useState<string | null>(null);
  useEffect(() => { getMyAccountId().then(setMyAccountId).catch(() => {}); }, []);
  // 회원 추가 시트
  const [addSheet, setAddSheet] = useState(false);
  const [gradeSheet, setGradeSheet] = useState(false);
  const [newGradeName, setNewGradeName] = useState("");
  const [newGradeColor, setNewGradeColor] = useState(GRADE_COLORS[0]);
  const [csvSheet, setCsvSheet] = useState(false);
  const [csvCols, setCsvCols] = useState<string[]>(["name", "grade", "phone", "passName", "remainingCount", "expiresAt"]);
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);
  // 알림톡 발송 — 목록에서 여러 명 선택하거나(선택 모드), 상세 시트에서 한 명만
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [alimtalkTargets, setAlimtalkTargets] = useState<CenterMember[] | null>(null);
  const [alimtalkBlocks, setAlimtalkBlocks] = useState<AlimtalkBlock[]>(emptyAlimtalkBlocks());
  const [sendingAlimtalk, setSendingAlimtalk] = useState(false);
  const [alimtalkAddonEnabled, setAlimtalkAddonEnabled] = useState(true); // 확인 전까지는 막지 않음

  // 수강권/상품 지급 — 주문 없이 매니저가 바로 발급(서비스로 무상 지급하는 경우 포함)
  const [grantTarget, setGrantTarget] = useState<CenterMember | null>(null);
  // 수강권 지급 / 상품 지급은 서로 다른 시트(같은 컴포넌트, 목록·사이즈 UI만 다름) — 회원 상세의 각 보유 섹션에서 연다.
  const [grantKind, setGrantKind] = useState<GrantKind>("pass");
  const [grantSize, setGrantSize] = useState<string | null>(null);
  // 수강권 만료일 연장(2026-10-02) — 대상 수강권, 방식(N일/날짜 지정), 입력값, 요청 중 상태
  const [extendTarget, setExtendTarget] = useState<{ id: string; name: string; expiresAt: string } | null>(null);
  const [extendMode, setExtendMode] = useState<ExtendMode>("days");
  const [extendDays, setExtendDays] = useState("30");
  const [extendDate, setExtendDate] = useState("");
  const [extendReason, setExtendReason] = useState("");
  const [extending, setExtending] = useState(false);
  // 구매 횟수 선택형 상품일 때만 사용하는 지급 횟수(고정 상품은 상품 정의 횟수로 지급)
  const [grantCount, setGrantCount] = useState<number | null>(null);
  const [grantProducts, setGrantProducts] = useState<SaleProduct[]>([]);
  const [grantProductId, setGrantProductId] = useState("");
  const [grantPrice, setGrantPrice] = useState("");
  const [grantMethod, setGrantMethod] = useState<GrantInput["payMethod"]>("card");
  const [grantMemo, setGrantMemo] = useState("");
  const [granting, setGranting] = useState(false);
  // 2026-10-01(Batch C, C-10) — weekdaySelectable 상품을 수동 발급할 때도 구매 플로우와
  // 동일하게 요일/시간 선택을 받는다(선택 없이 binding 누락된 membership이 생기지 않게).
  const [grantScheduleOptions, setGrantScheduleOptions] = useState<SelectableSchedule | null>(null);
  const [grantScheduleDay, setGrantScheduleDay] = useState<number | null>(null);
  const [grantScheduleTime, setGrantScheduleTime] = useState<string | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

  async function handleAddMember(profileId: string) {
    if (!centerId) return;
    setBusy(true);
    try {
      await addMemberToCenter(centerId, profileId);
      showToast("회원을 등록했어요");
      setAddSheet(false);
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  async function openDetail(m: CenterMember) {
    if (!centerId) return;
    setMemoText(m.memo ?? "");
    setAddressText(m.address ?? "");
    setDetailTab("info");
    setShowAllPasses(false); setShowAllGoods(false);
    setDetailData(null);
    setDetailLoading(true);
    setDetail(m);   // 시트를 열되, 내용은 로딩 후 한 번에 표시
    setMemberMemos([]);
    setMemberMemoInput("");
    setEditingMemberMemoId(null);
    try {
      setDetailData(await fetchMemberDetail(m.profileId, centerId));
      if (canViewMemo) setMemberMemos(await fetchMemberMemos(m.profileId));
    } catch (e: any) {
      setError(toUserMessage(e));
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleAddMemberMemo() {
    if (!detail || !centerId || !memberMemoInput.trim()) return;
    setMemberMemoBusy(true);
    try {
      await createMemberMemo(detail.profileId, centerId, memberMemoInput.trim());
      setMemberMemoInput("");
      setMemberMemos(await fetchMemberMemos(detail.profileId));
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setMemberMemoBusy(false); }
  }

  async function handleSaveMemberMemoEdit() {
    if (!detail || !editingMemberMemoId || !editingMemberMemoContent.trim()) return;
    setMemberMemoBusy(true);
    try {
      await updateMemberMemoEntry(editingMemberMemoId, editingMemberMemoContent.trim());
      setEditingMemberMemoId(null);
      setMemberMemos(await fetchMemberMemos(detail.profileId));
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setMemberMemoBusy(false); }
  }

  async function handleDeleteMemberMemo(memoId: string) {
    if (!detail) return;
    if (!(await globalThis.appConfirm("이 메모를 삭제할까요?"))) return;
    setMemberMemoBusy(true);
    try {
      await deleteMemberMemoEntry(memoId);
      setMemberMemos(await fetchMemberMemos(detail.profileId));
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setMemberMemoBusy(false); }
  }

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        if (list.length > 0) setCenterId(list[0].id);
        else setLoading(false);
      } catch (e: any) { setError(toUserMessage(e)); setLoading(false); }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!centerId) return;
    const seq = ++requestSeqRef.current;
    const isFirstLoad = !hasLoadedRef.current;
    if (isFirstLoad) setLoading(true); else setListSearching(true);
    setError(null);
    try {
      const [ms, gs] = await Promise.all([
        fetchMembers(centerId, { gradeId: gradeFilter, status: statusFilter, keyword, searchField }),
        fetchGrades(centerId),
      ]);
      // 이 요청이 시작된 뒤 더 최신 요청이 이미 시작됐다면(빠른 연속 검색) 이 결과는
      // stale이므로 버린다 — 화면엔 항상 "가장 최근에 시작한" 검색 결과만 반영된다.
      if (seq !== requestSeqRef.current) return;
      setMembers(ms); setGrades(gs);
      hasLoadedRef.current = true;
    } catch (e: any) {
      if (seq !== requestSeqRef.current) return;
      setError(toUserMessage(e));
    } finally {
      if (seq === requestSeqRef.current) { setLoading(false); setListSearching(false); }
    }
  }, [centerId, gradeFilter, statusFilter, keyword, searchField]);

  // 알림톡 애드온 미신청 센터는 서버(send-alimtalk)가 발송을 거부하므로, 필터 갱신마다
  // 다시 부르지 않게 centerId가 바뀔 때만 따로 확인한다(위 load()와 분리).
  useEffect(() => {
    if (!centerId) return;
    fetchCenterSubscription(centerId)
      .then((sub) => setAlimtalkAddonEnabled(sub?.alimtalkAddon ?? false))
      .catch(() => setAlimtalkAddonEnabled(true));
  }, [centerId]);

  // 센터 전환 시 "처음 선택"과 동일하게 다시 풀스크린 로딩부터 보여준다(다른 센터
  // 데이터이므로 이전 목록을 그대로 유지하면 오히려 혼란).
  useEffect(() => { hasLoadedRef.current = false; }, [centerId]);

  // 릴리스 폴리시 배치 8차(2026-09-17), 3-7 검색 성능 개선 — 감사 결과 실제 병목은
  // "등급/상태 필터 클릭까지 keyword와 똑같이 300ms 지연됨" + "매 keystroke마다 전체
  // 화면 로딩으로 이전 결과가 사라짐" + "느린 응답이 최신 검색을 덮어쓸 수 있음"(위
  // requestSeqRef) 세 가지였다. 등급/상태/검색필드/센터 전환은 사용자의 명시적 클릭이라
  // 디바운스 없이 즉시 반영하고, "타이핑" 자체(keyword)만 120~200ms 디바운스한다(아래
  // 별도 effect) — 이미 로드된 전체 목록을 다시 client-side로 필터링하는 대신 서버
  // 검색을 유지한 이유: 회원 검색은 이름/전화/주소 전체를 대상으로 하고(searchField),
  // 전화번호는 권한이 있는 사용자에게만 원문이 내려오는 등(customer.member.phone) 이미
  // 서버 쪽에서 마스킹/권한 처리가 끝난 값만 클라이언트가 받는 구조라(lib/members.ts)
  // "이미 로드된 데이터"만으로는애초에 안전하게 재현할 수 없다.
  useEffect(() => {
    if (!centerId) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerId, gradeFilter, statusFilter, searchField]);

  // 타이핑(keyword)만 짧게 디바운스 — 첫 마운트 때는 위 effect가 이미 처리하므로 건너뛴다.
  const keywordMounted = useRef(false);
  useEffect(() => {
    if (!keywordMounted.current) { keywordMounted.current = true; return; }
    const t = setTimeout(() => { load(); }, 180);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  const activeCenter = centers.find((c) => c.id === centerId);

  useEffect(() => {
    if (!activeCenter) return;
    if (activeCenter.isOwner) { setMyPerms(null); return; }
    let cancelled = false;
    setMyPerms(null);
    fetchMyEffectivePermissionKeys(activeCenter.managerCenterId, activeCenter.roleId)
      .then((keys) => { if (!cancelled) setMyPerms(keys); })
      .catch((e) => { if (!cancelled) setError(toUserMessage(e)); });
    return () => { cancelled = true; };
  }, [activeCenter]);

  function canDo(key: string): boolean {
    return canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, key);
  }
  // 정보 탭(메모/주소/등급/상태 저장)은 모두 customer.member.update RLS 하나로 묶여있다.
  const canUpdateMember = canDo("customer.member.update");
  const canCreateMember = canDo("customer.member.create");
  // 수강권 발급(customer.member.issue_pass)과 결제 등록(pass.payment.create) 둘 다 필요 —
  // memberships/payments insert RLS가 각각 이 두 키를 요구한다(fix_membership_rls.sql,
  // app/manager/sales/page.tsx의 registerPayment 주석과 동일한 조합).
  const canGrantPass = canDo("customer.member.issue_pass") && canDo("pass.payment.create");
  // 수강권 만료일 연장은 전용 권한(오너는 자동 통과). pass_detail/issue_pass만으로는 서버가 거부한다(RPC + expires_at 가드 트리거).
  const canExtendExpiry = canDo(EXPIRY_PERMISSION_KEY);
  const canExportMembers = canDo("customer.member.export");
  const canViewPhone = canDo("customer.member.phone");
  const canViewMemo = canDo("customer.memo.view");
  const canAddMemo = canDo("customer.memo.create");
  const canEditOwnMemo = canDo("customer.memo.update"); // 본인 메모 수정에도 이 키가 필요
  const canManageAnyMemo = activeCenter?.isOwner ?? false; // 다른 사람 메모는 오너만 — 위임 불가(서버 RLS와 동일 규칙)

  // URL ?profile=<profileId> 로 들어오면 그 회원 상세를 자동으로 열기 (1회)
  const searchParams = useSearchParams();
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current) return;
    const pid = searchParams.get("profile");
    if (!pid || members.length === 0) return;
    const target = members.find((m) => m.profileId === pid);
    if (target) {
      autoOpened.current = true;
      openDetail(target);
    }
  }, [searchParams, members]);

  async function handleSync() {
    if (!centerId) return;
    setBusy(true);
    try {
      const n = await syncMembersFromReservations(centerId);
      showToast(n > 0 ? `예약 이력에서 회원 ${n}명을 등록했어요` : "새로 등록할 회원이 없어요");
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  async function handleSaveMemo() {
    if (!detail) return;
    setBusy(true);
    try {
      await updateMemberMemo(detail.id, memoText);
      if (addressText !== (detail.address ?? "")) await updateMemberAddress(detail.profileId, addressText);
      showToast("저장했어요");
      setDetail(null);
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  async function handleSetGrade(gradeId: string | null) {
    if (!detail) return;
    setBusy(true);
    try {
      await updateMemberGrade(detail.id, gradeId);
      showToast("등급을 변경했어요");
      setDetail(null);
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  async function handleSetStatus(status: "active" | "expired" | "dormant") {
    if (!detail) return;
    setBusy(true);
    try {
      await updateMemberStatus(detail.id, status);
      showToast(status === "active" ? "활성 회원으로 전환했어요" : status === "expired" ? "만료 처리했어요" : "휴면 처리했어요");
      setDetail(null);
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  async function handleCreateGrade() {
    if (!centerId || !newGradeName.trim()) { setError("등급 이름을 입력해주세요"); return; }
    setBusy(true);
    try {
      await createGrade(centerId, newGradeName.trim(), newGradeColor);
      setNewGradeName("");
      showToast("등급을 추가했어요");
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  async function handleDeleteGrade(g: Grade) {
    if (!(await globalThis.appConfirm(`'${g.name}' 등급을 삭제할까요?\n이 등급을 쓰던 회원은 등급 없음이 됩니다.`))) return;
    setBusy(true);
    try {
      await deleteGrade(g.id);
      showToast("등급을 삭제했어요");
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setBusy(false); }
  }

  function handleCsvDownload() {
    if (csvCols.length === 0) { setError("내보낼 항목을 1개 이상 선택해주세요"); return; }
    // customer.member.phone 권한이 없으면 체크박스로 골랐어도 전화번호 컬럼은 제외 (방어적 이중 확인)
    const safeCols = canViewPhone ? csvCols : csvCols.filter((c) => c !== "phone");
    const csv = membersToCsv(members, safeCols);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const centerName = centers.find((c) => c.id === centerId)?.name ?? "회원목록";
    a.href = url;
    a.download = `${centerName}_회원목록_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setCsvSheet(false);
    showToast(`${members.length}명을 내보냈어요`);
  }

  function toggleSelectMode() {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // members는 이미 등급/상태/검색 필터가 적용된 결과라, "전체 선택"이 곧 "필터링된
  // 회원 전체 선택"이다 — 별도의 "필터 결과에 발송" 경로를 안 만들어도 된다.
  function selectAllFiltered() {
    setSelectedIds(new Set(members.map((m) => m.id)));
  }

  function deselectAll() {
    setSelectedIds(new Set());
  }

  function openAlimtalkForSelected() {
    const targets = members.filter((m) => selectedIds.has(m.id));
    if (targets.length === 0) return;
    setAlimtalkBlocks(emptyAlimtalkBlocks());
    setAlimtalkTargets(targets);
  }

  function openAlimtalkForOne(m: CenterMember) {
    setAlimtalkBlocks(emptyAlimtalkBlocks());
    setAlimtalkTargets([m]);
  }

  async function openGrant(m: CenterMember, kind: GrantKind) {
    if (!centerId) return;
    setGrantKind(kind);
    setGrantProductId(""); setGrantPrice(""); setGrantMethod("card"); setGrantMemo("");
    setGrantScheduleOptions(null); setGrantScheduleDay(null); setGrantScheduleTime(null); setGrantSize(null); setGrantCount(null);
    setGrantProducts([]);
    setGrantTarget(m);
    try {
      // 수강권 시트에는 goods가 나오지 않고, 상품 시트에는 goods만 나온다(서버 쿼리 + 순수 필터 이중).
      setGrantProducts(await fetchGrantableProducts(centerId, kind));
    } catch (e: any) { setError(toUserMessage(e)); }
  }

  function pickGrantProduct(id: string) {
    setGrantProductId(id);
    const p = grantProducts.find((x) => x.id === id);
    // 선택형 상품은 최소 횟수를 기본으로 두고 가격 기본값 = 1회가 × 횟수(관리자가 수정 가능), 고정 상품은 상품가
    const firstCount = grantCountOptions(p)[0] ?? null;
    setGrantCount(firstCount);
    const dp = defaultGrantPrice(p, firstCount);
    setGrantPrice(p && dp != null ? String(dp) : "");
    // 가격이 있는 상품을 새로 고르면 "서비스"로 남아있던 결제방법을 실수로 유지하지 않게 초기화
    if (p && (dp ?? 0) > 0 && grantMethod === "service") setGrantMethod("card");
    // 2026-10-01(Batch C, C-10) — 상품을 바꾸면 이전 상품의 요일/시간 선택은 무효이므로 초기화.
    setGrantScheduleDay(null); setGrantScheduleTime(null);
    // 프로필 신발 사이즈가 상품 sizes 중 하나면 기본 선택으로 제안(관리자가 확인·변경 가능)
    setGrantSize(p ? suggestGrantSize(p, detailData?.profileInfo?.shoeSize) : null);
    if (p?.weekdaySelectable) {
      fetchPurchaseScheduleOptions(p.id).then(setGrantScheduleOptions).catch(() => setGrantScheduleOptions({ days: [], timesByDay: {} }));
    } else {
      setGrantScheduleOptions(null);
    }
  }

  function openExtend(p: { id: string; name: string; expiresAt: string | null }) {
    if (!p.expiresAt) return;
    setExtendTarget({ id: p.id, name: p.name, expiresAt: p.expiresAt });
    setExtendMode("days"); setExtendDays("30"); setExtendDate(""); setExtendReason("");
  }

  async function handleExtend() {
    if (!extendTarget || extending) return;
    const pv = previewExtension({ currentExpiresAt: extendTarget.expiresAt, mode: extendMode, days: extendDays, newDate: extendDate });
    if (pv.error || !pv.newExpiresAt) { setError(pv.error ?? "새 만료일을 확인해주세요"); return; }
    if (extendReason.length > MAX_REASON_LENGTH) { setError(`연장 사유는 ${MAX_REASON_LENGTH}자 이내로 입력해주세요`); return; }
    const ok = await globalThis.appConfirm(extensionConfirmMessage({
      passName: extendTarget.name, current: extendTarget.expiresAt, next: pv.newExpiresAt, mode: extendMode,
      days: extendMode === "days" ? parseInt(extendDays, 10) : null,
    }));
    if (!ok) return;
    setExtending(true); setError(null);
    try {
      const r = await extendMembershipExpiry({
        membershipId: extendTarget.id, mode: extendMode,
        days: extendMode === "days" ? parseInt(extendDays, 10) : null,
        newExpiresAt: extendMode === "date" ? extendDate : null, reason: extendReason,
      });
      showToast(extensionSuccessMessage(r.newExpiresAt));
      setExtendTarget(null);
      if (detail) await openDetail(detail);   // 회원 상세를 다시 불러와 새 만료일이 바로 보이게
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setExtending(false); }
  }

  async function handleGrant() {
    if (!centerId || !grantTarget || !grantProductId) return;
    const price = Number(grantPrice);
    if (!Number.isFinite(price) || price < 0) { setError("가격을 숫자로 입력해주세요"); return; }
    if (price === 0 && grantMethod !== "service") { setError("가격이 0원이면 결제방법은 '서비스'여야 해요"); return; }
    if (price > 0 && grantMethod === "service") { setError("가격이 있으면 '서비스'로는 지급할 수 없어요 — 결제방법을 골라주세요"); return; }
    const product = grantProducts.find((p) => p.id === grantProductId);
    if (!product) return;
    // 2026-10-01(Batch C, C-10) — 구매 화면(app/checkout)과 동일하게 선택 없이는 발급을 막는다.
    const blocked = grantBlockReason({ product, price: grantPrice, selectedSize: grantSize, scheduleDay: grantScheduleDay, scheduleTime: grantScheduleTime, selectedCount: grantCount });
    if (blocked) { setError(blocked); return; }
    setGranting(true); setError(null);
    try {
      await grantProductToMember({
        centerId, profileId: grantTarget.profileId, productId: product.id, productName: product.name,
        price, payMethod: grantMethod, memo: grantMemo.trim() || undefined,
        paidAt: new Date().toISOString(),
        boundDayOfWeek: product.kind !== "goods" && product.weekdaySelectable ? grantScheduleDay : undefined,
        boundStartTime: product.kind !== "goods" && product.weekdaySelectable && product.timeSelectable ? grantScheduleTime : undefined,
        selectedSize: productNeedsSize(product) ? grantSize : undefined,
        // 선택형 상품만 횟수를 보낸다(고정 상품은 서버가 상품 정의 횟수로 지급하고 횟수 지정을 거부).
        selectedCount: grantCountOptions(product).length > 0 ? grantCount : undefined,
      });
      showToast(price === 0 ? "서비스로 지급했어요" : "지급하고 매출에 반영했어요");
      setGrantTarget(null);
      if (detail?.id === grantTarget.id) await openDetail(grantTarget); // 상세 시트가 열려 있으면 보유 수강권 갱신
      await load();
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setGranting(false); }
  }

  async function handleSendAlimtalk() {
    if (!alimtalkTargets || !hasAlimtalkContent(alimtalkBlocks) || !centerId) return;
    if (!alimtalkAddonEnabled) {
      setError("이 센터는 카카오 알림톡/SMS 발송 애드온을 신청하지 않아 발송할 수 없어요");
      return;
    }
    // 이 화면은 템플릿 선택 없이 자유 문장만 쓰므로 항상 SMS로 나간다(카카오 알림톡 아님) —
    // 요금이 알림톡과 달라서 매번 확인받는다(app/manager/alimtalk/send와 같은 패턴).
    const recipientCount = alimtalkTargets.filter((m) => m.phone).length;
    const ok = await globalThis.appConfirm(
      `카카오 알림톡이 아니라 SMS로 나가요.\n번호가 있는 ${recipientCount}명에게 SMS 요금이 발생해요 — 계속할까요?`
    );
    if (!ok) return;
    setSendingAlimtalk(true);
    try {
      const content = flattenAlimtalkBlocks(alimtalkBlocks);
      // 2026-10-01(A-4) — 이 화면은 템플릿 선택 없이 자유 문장만 쓰지만, sendAlimtalkToMembers가
      // 이제 [[변수]]를 항상 검사·치환한다(회귀 없음 — 자유 문장에 우연히 [[..]] 형태가
      // 없으면 평소처럼 그대로 나간다). centerName은 [[센터명]]을 직접 타이핑한 경우에만 쓰임.
      const centerName = centers.find((c) => c.id === centerId)?.name ?? "";
      const result = await sendAlimtalkToMembers(alimtalkTargets, content, centerId, undefined, { centerName });
      const parts: string[] = [];
      if (result.sent > 0) parts.push(`${result.sent}명 발송`);
      if (result.skipped > 0) parts.push(`${result.skipped}명 번호 없음`);
      if (result.failed > 0) parts.push(`${result.failed}명 실패`);
      if (result.unresolved > 0) parts.push(`${result.unresolved}명 변수 미입력으로 건너뜀`);
      showToast(parts.join(" · "));
      setAlimtalkTargets(null);
      setSelectMode(false);
      setSelectedIds(new Set());
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setSendingAlimtalk(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell manager-members-v2">
        <div className="back-header">
          <div className="side" />
          <div className="title">내 회원</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell manager-members-v2">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <div className="side" />
        <div className="title">내 회원</div>
        <div style={{ display: "flex", gap: 6 }}>
          {canCreateMember && (
            <button className="header-action" onClick={() => setAddSheet(true)}>+회원</button>
          )}
          <button className="header-action" onClick={() => setGradeSheet(true)}>등급</button>
        </div>
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button aria-pressed={c.id === centerId} key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {/* 검색 + 필터 */}
      <>
      <div className="mem-search" style={{ display: "flex", gap: 8 }}>
        <select className="input-field" style={{ flex: "0 0 96px" }} value={searchField} onChange={(e) => setSearchField(e.target.value as any)}>
          <option value="all">전체</option>
          <option value="name">이름</option>
          {canViewPhone && <option value="phone">휴대폰</option>}
          <option value="address">주소</option>
        </select>
        <input aria-label={searchField === "address" ? "주소 검색" : searchField === "phone" ? "휴대폰 번호 검색" : "이름 검색"}
          className="input-field"
          style={{ flex: 1 }}
          placeholder={searchField === "address" ? "주소 검색" : searchField === "phone" ? "휴대폰 번호 검색" : "이름 검색"}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {/* 릴리스 폴리시 배치 8차(2026-09-17), 3-5 — "등급 전체"는 항상 좌측 고정, 실제
          등급 칩만 horizontal scroll(.mem-filters-scroll)되게 분리. 예전엔 .mem-filters
          전체가 하나의 overflow-x:auto라 "전체" 버튼까지 같이 스크롤되어 사라졌다. */}
      <div className="mem-filters">
        <button aria-pressed={!gradeFilter} className={`filter-chip all-chip ${!gradeFilter ? "on" : ""}`} onClick={() => setGradeFilter(null)}>등급 전체</button>
        <div className="mem-filters-scroll">
          {grades.map((g) => (
            <button aria-pressed={gradeFilter === g.id} key={g.id} className={`filter-chip ${gradeFilter === g.id ? "on" : ""}`} onClick={() => setGradeFilter(g.id)}>
              <span className="grade-dot" style={{ background: g.color ?? "var(--line-strong)" }} />{g.name}
            </button>
          ))}
        </div>
      </div>

      {/* 3-6 — 상태 필터도 동일 구조("상태 전체" 고정 + 나머지 스크롤). */}
      <div className="mem-filters">
        <button aria-pressed={!statusFilter} className={`filter-chip all-chip ${!statusFilter ? "on" : ""}`} onClick={() => setStatusFilter(null)}>상태 전체</button>
        <div className="mem-filters-scroll">
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <button aria-pressed={statusFilter === k} key={k} className={`filter-chip ${statusFilter === k ? "on" : ""}`} onClick={() => setStatusFilter(k)}>{v}</button>
          ))}
        </div>
      </div>
      <div className="perm-guide" style={{ margin: "0 16px 4px", fontSize: 11.5 }}>
        수강권을 구매한 사람만 회원으로 표시돼요. 횟수 소진·기간 만료는 '만료', 휴면 처리 시 기간권 시간이 정지돼요.
      </div>

      <div className="mem-toolbar">
        <span className="mem-count">전체 {members.length}명{listSearching && <span className="mem-searching"> · 검색 중…</span>}</span>
        <div className="mem-tools member-toolbar-actions">
          <button className="quiet-action" disabled={busy} onClick={handleSync} title="예약 이력은 있지만 아직 회원 목록에 없는 사람을 찾아 등록해요">예약자 동기화</button>
          <button className={`quiet-action ${selectMode ? "on" : ""}`} onClick={toggleSelectMode}>
            {selectMode ? "선택 취소" : "알림톡 발송"}
          </button>
          {canExportMembers && (
            <button className="quiet-action" onClick={() => setCsvSheet(true)}>엑셀 내보내기</button>
          )}
        </div>
      </div>

      {selectMode && (
        <div className="mem-toolbar">
          <span className="mem-count">{selectedIds.size}/{members.length}명 선택됨 (현재 필터 기준)</span>
          <div className="mem-tools member-toolbar-actions">
            {selectedIds.size === members.length && members.length > 0 ? (
              <button className="quiet-action" onClick={deselectAll}>전체 해제</button>
            ) : (
              <button className="quiet-action" disabled={members.length === 0} onClick={selectAllFiltered}>전체 선택</button>
            )}
          </div>
        </div>
      )}
      </>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : members.length === 0 ? (
        statusFilter || keyword.trim() ? (
          <div className="daylist-empty" style={{ padding: "50px 20px", lineHeight: 1.7 }}>
            {keyword.trim()
              ? "검색 결과가 없어요"
              : statusFilter === "expired" ? "만료된 회원이 없어요"
              : statusFilter === "dormant" ? "휴면 회원이 없어요"
              : statusFilter === "active" ? "이용 중인 회원이 없어요"
              : "해당하는 회원이 없어요"}
          </div>
        ) : (
          <div className="empty-action">
            <div className="empty-action-text">
              아직 등록된 회원이 없어요.<br />
              회원을 추가하거나, 예약 이력이 있으면 동기화해보세요.
            </div>
            {canCreateMember && (
              <button className="empty-action-btn" onClick={() => setAddSheet(true)}>+ 첫 회원 등록하기</button>
            )}
          </div>
        )
      ) : (
        <div className="mem-list" style={selectMode && selectedIds.size > 0 ? { paddingBottom: 90 } : undefined}>
          {members.map((m) => (
            <button
              key={m.id}
              className={`mem-row ${selectMode && selectedIds.has(m.id) ? "selected" : ""}`}
              onClick={() => (selectMode ? toggleSelected(m.id) : openDetail(m))}
            >
              {selectMode && (
                <input
                  type="checkbox"
                  className="mem-row-check"
                  checked={selectedIds.has(m.id)}
                  onChange={() => toggleSelected(m.id)}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              <div className="mem-main">
                <div className="mem-name-line">
                  <span className="mem-name">{m.name}</span>
                  {m.gradeName && (
                    <span className="grade-badge" style={{ background: m.gradeColor ? m.gradeColor + "22" : "var(--surface)", color: m.gradeColor ?? "var(--text-dim)" }}>
                      {m.gradeName}
                    </span>
                  )}
                  {!m.appLinked && <span className="mem-flag">앱 미연결</span>}
                  {m.status === "dormant" && <span className="mem-status-badge dormant">휴면</span>}
                  {m.status === "expired" && m.hasPass && <span className="mem-status-badge expired">만료</span>}
                  {m.status === "expired" && !m.hasPass && <span className="mem-status-badge expired">수강권 없음</span>}
                </div>
                <div className="mem-sub">
                  {m.phone ?? "번호 없음"}
                  {m.passName && ` · ${m.passName}`}
                  {m.remainingCount != null && ` (${m.remainingCount}회)`}
                </div>
              </div>
              {!selectMode && <span className="chevron">›</span>}
            </button>
          ))}
        </div>
      )}

      {selectMode && selectedIds.size > 0 && !alimtalkTargets && (
        <div className="mem-select-bar">
          <span>{selectedIds.size}명 선택됨</span>
          <button className="primary-btn compact" onClick={openAlimtalkForSelected}>알림톡 발송</button>
        </div>
      )}

      {/* 회원 상세 시트 */}
      {detail && (
        <SheetOverlay className="sheet-overlay" onClick={() => setDetail(null)}>
          <div className="sheet member-detail-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title mem-detail-title">
              <span>{detail.name}</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button className="outline-action compact" onClick={() => openAlimtalkForOne(detail)}>알림톡 보내기</button>
              </div>
            </div>
            {detailLoading && <Loading />}
            {!detailLoading && (<>

            {/* 보유 수강권 / 상품 요약 (각 최대 3개 + 전체보기) */}
            {detailData && (() => {
              const passes = detailData.activePasses.filter((p) => p.kind !== "goods");
              const goods = detailData.activePasses.filter((p) => p.kind === "goods");
              return (
                <>
                  {/* 보유 수강권 — 0개여도 섹션과 지급 버튼은 항상 보인다("직접배치"와는 별개: 이건 보유상품 추가) */}
                  <div className="mem-pass-block">
                    <div className="mem-pass-head">
                      <span className="mem-pass-head-title">보유 수강권 {passes.length}</span>
                      <span className="mem-pass-head-actions">
                        {passes.length > 3 && (
                          <button className="mem-pass-more" onClick={() => setShowAllPasses((v) => !v)}>
                            {showAllPasses ? "접기" : "전체보기"}
                          </button>
                        )}
                        {canGrantPass && (
                          <button className="outline-action compact" onClick={() => openGrant(detail, "pass")}>+ 수강권 지급</button>
                        )}
                      </span>
                    </div>
                    {passes.length === 0 ? (
                      <div className="mem-pass-empty">보유 중인 수강권이 없어요</div>
                    ) : (
                      <div className="mem-pass-summary">
                        {(showAllPasses ? passes : passes.slice(0, 3)).map((p) => (
                          <div key={p.id} className="mem-pass-chip mem-pass-chip-row">
                            <span className="mem-pass-chip-text">
                              {p.name}{p.remaining != null ? ` · ${p.remaining}회` : ""} <span className="mem-pass-exp">~{p.expiresAt ?? "무제한"}</span>
                            </span>
                            {/* 만료일이 있는 수강권만(무제한/상품 제외) + 전용 권한이 있을 때만 */}
                            {canExtendExpiry && isExtendablePass(p) && (
                              <button type="button" className="mem-pass-extend" onClick={() => openExtend(p)}>연장</button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 보유 상품(대여화 등) */}
                  <div className="mem-pass-block">
                    <div className="mem-pass-head">
                      <span className="mem-pass-head-title">보유 상품 {goods.length}</span>
                      <span className="mem-pass-head-actions">
                        {goods.length > 3 && (
                          <button className="mem-pass-more" onClick={() => setShowAllGoods((v) => !v)}>
                            {showAllGoods ? "접기" : "전체보기"}
                          </button>
                        )}
                        {canGrantPass && (
                          <button className="outline-action compact" onClick={() => openGrant(detail, "goods")}>+ 상품 지급</button>
                        )}
                      </span>
                    </div>
                    {goods.length === 0 ? (
                      <div className="mem-pass-empty">보유 중인 상품이 없어요</div>
                    ) : (
                      <div className="mem-pass-summary">
                        {(showAllGoods ? goods : goods.slice(0, 3)).map((p) => (
                          <div key={p.id} className="mem-pass-chip goods">
                            {holdingLabel({ name: p.name, remaining: p.remaining, selectedSize: p.selectedSize })} <span className="mem-pass-exp">~{p.expiresAt ?? "무제한"}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              );
            })()}

            {/* 탭 */}
            <div className="perm-tabs" style={{ marginTop: 4 }}>
              <button aria-pressed={detailTab === "info"} className={`perm-tab ${detailTab === "info" ? "on" : ""}`} onClick={() => setDetailTab("info")}>정보</button>
              <button aria-pressed={detailTab === "reservations"} className={`perm-tab ${detailTab === "reservations" ? "on" : ""}`} onClick={() => setDetailTab("reservations")}>예약</button>
              <button aria-pressed={detailTab === "progress"} className={`perm-tab ${detailTab === "progress" ? "on" : ""}`} onClick={() => setDetailTab("progress")}>진도</button>
              <button aria-pressed={detailTab === "payments"} className={`perm-tab ${detailTab === "payments" ? "on" : ""}`} onClick={() => setDetailTab("payments")}>결제</button>
            </div>

            {detailTab === "info" && (
              <>
                <div className="admin-row"><span className="k">전화</span><span className="v">{detail.phone ?? "-"}</span></div>
                <div className="admin-row"><span className="k">등록일</span><span className="v">{detail.registeredAt}</span></div>
                <div className="admin-row"><span className="k">최근출석</span><span className="v">{detail.lastAttendedAt ?? "-"}</span></div>
                <div className="admin-row"><span className="k">앱연결</span><span className="v">{detail.appLinked ? "연결됨" : "미연결"}</span></div>

                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>등급</div>
                <div className="mem-filters" style={{ padding: 0 }}>
                  <button aria-pressed={!detail.gradeId} className={`filter-chip ${!detail.gradeId ? "on" : ""}`} disabled={busy || !canUpdateMember} onClick={() => handleSetGrade(null)}>없음</button>
                  {grades.map((g) => (
                    <button aria-pressed={detail.gradeId === g.id} key={g.id} className={`filter-chip ${detail.gradeId === g.id ? "on" : ""}`} disabled={busy || !canUpdateMember} onClick={() => handleSetGrade(g.id)}>
                      <span className="grade-dot" style={{ background: g.color ?? "var(--line-strong)" }} />{g.name}
                    </button>
                  ))}
                </div>

                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>회원 상태</div>
                <div className="mem-filters" style={{ padding: 0 }}>
                  <button aria-pressed={detail.status === "active"} className={`filter-chip ${detail.status === "active" ? "on" : ""}`} disabled={busy || !canUpdateMember} onClick={() => handleSetStatus("active")}>활성</button>
                  <button aria-pressed={detail.status === "dormant"} className={`filter-chip ${detail.status === "dormant" ? "on" : ""}`} disabled={busy || !canUpdateMember} onClick={() => handleSetStatus("dormant")}>휴면</button>
                  <button aria-pressed={detail.status === "expired"} className={`filter-chip ${detail.status === "expired" ? "on" : ""}`} disabled={busy || !canUpdateMember} onClick={() => handleSetStatus("expired")}>만료</button>
                </div>
                <div className="perm-guide" style={{ margin: "6px 0 0" }}>
                  {canUpdateMember
                    ? "휴면·만료 처리해도 기록은 남아요. 회원 목록 상단 상태 필터로 볼 수 있어요."
                    : "회원 정보 수정 권한이 없어요 — 오너에게 문의하세요."}
                </div>

                {detailData?.profileInfo && (() => {
                  const pi = detailData.profileInfo;
                  const rows = [
                    ["생년월일", pi.birthDate],
                    ["성별", pi.gender === "female" ? "여성" : pi.gender === "male" ? "남성" : pi.gender],
                    ["발 사이즈", pi.shoeSize ? `${pi.shoeSize}mm` : null],
                    ["옷 사이즈", pi.clothSize],
                    ["주소", pi.address],
                    ["추가 연락처", pi.phone],
                    ["특이사항", pi.memo],
                  ].filter(([, v]) => v);
                  if (rows.length === 0) return null;
                  return (
                    <>
                      <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
                        회원이 입력한 정보
                      </div>
                      <div className="mem-profile-info">
                        {rows.map(([k, v]) => (
                          <div key={k as string} className="mem-profile-row">
                            <span className="mem-profile-key">{k}</span>
                            <span className="mem-profile-val">{v}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  );
                })()}

                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>주소 (관리자 기록용)</div>
                <input aria-label="회원 주소" className="input-field" disabled={!canUpdateMember} placeholder="예: 서울 강남구 ..." value={addressText} onChange={(e) => setAddressText(e.target.value)} />

                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>관리자 메모 (회원에게 보이지 않음)</div>
                <input aria-label="회원 메모" className="input-field" disabled={!canUpdateMember} placeholder="예: 무릎 부상 이력" value={memoText} onChange={(e) => setMemoText(e.target.value)} />

                {canViewMemo && (
                  <>
                    <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>회원 메모 (스태프 전용, 여러 명이 각자 남길 수 있음)</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {memberMemos.map((m) => {
                        const canEditThis = (m.authorAccountId === myAccountId && canEditOwnMemo) || canManageAnyMemo;
                        return (
                          <div key={m.id} style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px" }}>
                            {editingMemberMemoId === m.id ? (
                              <>
                                <textarea
                                  className="input-field" style={{ width: "100%", minHeight: 60 }}
                                  value={editingMemberMemoContent} onChange={(e) => setEditingMemberMemoContent(e.target.value)}
                                />
                                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                                  <button className="quiet-action" disabled={memberMemoBusy} onClick={handleSaveMemberMemoEdit}>저장</button>
                                  <button className="quiet-action" disabled={memberMemoBusy} onClick={() => setEditingMemberMemoId(null)}>취소</button>
                                </div>
                              </>
                            ) : (
                              <>
                                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{m.content}</div>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{m.authorName} · {new Date(m.createdAt).toLocaleString("ko-KR")}</span>
                                  {canEditThis && (
                                    <div style={{ display: "flex", gap: 6 }}>
                                      <button className="quiet-action" disabled={memberMemoBusy} onClick={() => { setEditingMemberMemoId(m.id); setEditingMemberMemoContent(m.content); }}>수정</button>
                                      <button className="quiet-action danger" disabled={memberMemoBusy} onClick={() => handleDeleteMemberMemo(m.id)}>삭제</button>
                                    </div>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                      {memberMemos.length === 0 && <div className="daylist-empty" style={{ padding: 12 }}>등록된 메모가 없어요</div>}
                      {canAddMemo && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <textarea aria-label="메모를 남겨보세요"
                            className="input-field" style={{ width: "100%", minHeight: 50 }}
                            placeholder="메모를 남겨보세요" value={memberMemoInput} onChange={(e) => setMemberMemoInput(e.target.value)}
                          />
                          <button className="quiet-action" disabled={memberMemoBusy || !memberMemoInput.trim()} onClick={handleAddMemberMemo}>등록</button>
                        </div>
                      )}
                    </div>
                  </>
                )}

                <div className="add-profile-actions">
                  <button className="ghost-btn" onClick={() => setDetail(null)}>닫기</button>
                  {canUpdateMember && (
                    <button className="primary-btn" disabled={busy} onClick={handleSaveMemo}>메모 저장</button>
                  )}
                </div>
              </>
            )}

            {detailTab === "reservations" && (
              <div className="mem-detail-list">
                {!detailData ? <Loading />
                  : detailData.reservations.length === 0 ? <div className="daylist-empty" style={{ padding: 20 }}>예약 내역이 없어요</div>
                  : detailData.reservations.map((r) => (
                    <div key={r.id} className="mem-detail-row">
                      <span className="mem-detail-date">{r.date}</span>
                      <span className="mem-detail-main">{r.title}</span>
                      <span className={`hist-status s-${r.status}`}>{RES_STATUS[r.status] ?? r.status}</span>
                    </div>
                  ))}
              </div>
            )}

            {detailTab === "progress" && (
              <div className="mem-detail-list">
                {!detailData ? <Loading />
                  : detailData.progress.length === 0 ? <div className="daylist-empty" style={{ padding: 20 }}>진도 기록이 없어요</div>
                  : detailData.progress.map((p) => (
                    <div key={p.id} className="mem-prog-row">
                      <div className="mem-prog-line">
                        <span className="mem-detail-date">{p.date}</span>
                        <span className="mem-detail-main">{p.skill}</span>
                      </div>
                      {p.note && <div className="mem-prog-note">{p.note}</div>}
                    </div>
                  ))}
              </div>
            )}

            {detailTab === "payments" && (
              <div className="mem-detail-list">
                {!detailData ? <Loading />
                  : detailData.payments.length === 0 ? <div className="daylist-empty" style={{ padding: 20 }}>결제 내역이 없어요</div>
                  : detailData.payments.map((p) => (
                    <div key={p.id} className="mem-detail-row">
                      <span className="mem-detail-date">{p.date}</span>
                      <span className="mem-detail-main">
                        {SALE_LABEL[p.saleType] ?? p.saleType}
                        {p.unpaid > 0 && <span className="drill-unpaid"> 미수 {p.unpaid.toLocaleString("ko-KR")}원</span>}
                      </span>
                      <span className={`mem-detail-amt ${p.amount < 0 ? "minus" : ""}`}>{p.amount.toLocaleString("ko-KR")}원</span>
                    </div>
                  ))}
              </div>
            )}
            </>)}
          </div>
        </SheetOverlay>
      )}

      {/* 등급 관리 시트 */}
      {gradeSheet && (
        <SheetOverlay className="sheet-overlay" onClick={() => setGradeSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">회원 등급 관리</div>

            {grades.length === 0 ? (
              <div className="daylist-empty" style={{ padding: "16px 0" }}>등급이 없어요</div>
            ) : (
              <div className="grade-list">
                {grades.map((g) => (
                  <div key={g.id} className="grade-item">
                    <span className="grade-dot" style={{ background: g.color ?? "var(--line-strong)" }} />
                    <span className="grade-name">{g.name}</span>
                    <button className="quiet-action danger" disabled={busy} onClick={() => handleDeleteGrade(g)}>삭제</button>
                  </div>
                ))}
              </div>
            )}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>등급 추가</div>
            <input aria-label="등급 이름 (예: VIP)" className="input-field" placeholder="등급 이름 (예: VIP)" value={newGradeName} onChange={(e) => setNewGradeName(e.target.value)} />
            <div className="color-picker">
              {GRADE_COLORS.map((c) => (
                <button key={c} className={`color-dot ${newGradeColor === c ? "on" : ""}`} style={{ background: c }} onClick={() => setNewGradeColor(c)} />
              ))}
            </div>

            <div className="add-profile-actions">
              <button className="ghost-btn" onClick={() => setGradeSheet(false)}>닫기</button>
              <button className="primary-btn" disabled={busy} onClick={handleCreateGrade}>추가</button>
            </div>
          </div>
        </SheetOverlay>
      )}

      {/* 엑셀 내보내기 시트 */}
      {csvSheet && (
        <SheetOverlay className="sheet-overlay" onClick={() => setCsvSheet(false)}>
          <div className="sheet csv-export-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">엑셀 내보내기</div>
            <div className="sheet-lead">필요한 회원 정보만 선택해서 내보낼 수 있어요.</div>

            <div className="csv-cols">
              {CSV_COLUMNS.filter((c) => c.key !== "phone" || canViewPhone).map((c) => (
                <label key={c.key} className="csv-col">
                  <input
                    type="checkbox"
                    checked={csvCols.includes(c.key)}
                    onChange={(e) =>
                      setCsvCols((prev) => e.target.checked ? [...prev, c.key] : prev.filter((k) => k !== c.key))
                    }
                  />
                  {c.label}
                </label>
              ))}
            </div>

            <div className="add-profile-actions csv-export-actions">
              <button className="ghost-btn" onClick={() => setCsvSheet(false)}>취소</button>
              <button className="primary-btn" onClick={handleCsvDownload}>{members.length}명 내보내기</button>
            </div>
          </div>
        </SheetOverlay>
      )}

      {/* 회원 추가 시트 — 검색 UI/stale 방어는 MemberAddSheet. key={centerId}: 센터가 바뀌면 이전 센터의 검색 상태를 버린다. */}
      {addSheet && centerId && (
        <MemberAddSheet key={centerId} centerId={centerId} centerName={activeCenter?.name ?? null} busy={busy} onClose={() => setAddSheet(false)} onAdd={handleAddMember} />
      )}

      {/* 수강권 만료일 연장 시트 — 이미 발급된 수강권 1개의 만료일만 연장(단축/무제한 변환 불가). 서버가 최종 검증 */}
      {extendTarget && (() => {
        const pv = previewExtension({ currentExpiresAt: extendTarget.expiresAt, mode: extendMode, days: extendDays, newDate: extendDate });
        return (
          <SheetOverlay className="sheet-overlay" swipeDismiss={!extending} onClick={() => !extending && setExtendTarget(null)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-title">수강권 만료일 연장</div>
              <div className="admin-row"><span className="k">수강권</span><span className="v">{extendTarget.name}</span></div>
              <div className="admin-row"><span className="k">현재 만료일</span><span className="v">{formatDotDate(extendTarget.expiresAt)}</span></div>

              <div className="mem-filters" style={{ padding: 0, margin: "10px 0" }}>
                <button type="button" aria-pressed={extendMode === "days"} className={`filter-chip ${extendMode === "days" ? "on" : ""}`}
                  disabled={extending} onClick={() => setExtendMode("days")}>N일 연장</button>
                <button type="button" aria-pressed={extendMode === "date"} className={`filter-chip ${extendMode === "date" ? "on" : ""}`}
                  disabled={extending} onClick={() => setExtendMode("date")}>날짜 지정</button>
              </div>

              {extendMode === "days" ? (
                <>
                  <div className="menu-section-label" style={{ padding: "0 0 6px" }}>연장 일수</div>
                  <div className="deadline-row">
                    <input aria-label="연장 일수" className="input-field" inputMode="numeric" style={{ maxWidth: 110 }}
                      value={extendDays} disabled={extending}
                      onChange={(e) => setExtendDays(e.target.value.replace(/[^0-9]/g, ""))} />
                    <span className="deadline-unit">일</span>
                  </div>
                  <div className="mem-filters" style={{ padding: 0, marginTop: 8 }}>
                    {QUICK_EXTEND_DAYS.map((n) => (
                      <button type="button" key={n} aria-pressed={extendDays === String(n)} className={`filter-chip ${extendDays === String(n) ? "on" : ""}`}
                        disabled={extending} onClick={() => setExtendDays(String(n))}>+{n}일</button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="menu-section-label" style={{ padding: "0 0 6px" }}>새 만료일</div>
                  <input aria-label="새 만료일" type="date" className="input-field" value={extendDate} disabled={extending}
                    min={extendTarget.expiresAt} onChange={(e) => setExtendDate(e.target.value)} />
                </>
              )}

              <div className={`perm-guide ${pv.error && (extendMode === "date" ? extendDate : extendDays) ? "is-error" : ""}`} style={{ margin: "10px 0" }}>
                {pv.newExpiresAt && !pv.error
                  ? `${formatDotDate(extendTarget.expiresAt)} → ${formatDotDate(pv.newExpiresAt)}${pv.daysAdded ? ` (+${pv.daysAdded}일)` : ""}`
                  : pv.error ?? "연장할 기간을 입력해주세요"}
              </div>

              <div className="menu-section-label" style={{ padding: "0 0 6px" }}>연장 사유 (선택)</div>
              <input aria-label="연장 사유" className="input-field" maxLength={MAX_REASON_LENGTH} placeholder="예: 회원 부상으로 2주 연장"
                value={extendReason} disabled={extending} onChange={(e) => setExtendReason(e.target.value)} style={{ marginBottom: 10 }} />
              <div className="perm-guide" style={{ margin: "0 0 10px" }}>잔여 횟수·결제·예약은 바뀌지 않고, 이 수강권 1개의 만료일만 연장돼요.</div>

              <div className="add-profile-actions">
                <button className="ghost-btn" disabled={extending} onClick={() => setExtendTarget(null)}>취소</button>
                <button className="primary-btn" disabled={extending || !!pv.error || !pv.newExpiresAt} onClick={handleExtend}>
                  {extending ? "연장 중..." : "만료일 연장"}
                </button>
              </div>
            </div>
          </SheetOverlay>
        );
      })()}

      {/* 수강권/상품 지급 시트 — 주문 없이 매니저가 바로 발급(서비스 무상 지급 포함) */}
      {grantTarget && (
        <SheetOverlay className="sheet-overlay" swipeDismiss={!granting} onClick={() => !granting && setGrantTarget(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{grantSheetTitle(grantTarget.name, grantKind)}</div>

            <div className="menu-section-label" style={{ padding: "0 0 6px" }}>{grantKind === "goods" ? "상품" : "수강권"}</div>
            <select
              className="input-field" style={{ marginBottom: 10 }}
              value={grantProductId} disabled={granting}
              onChange={(e) => pickGrantProduct(e.target.value)}
            >
              <option value="">{grantKind === "goods" ? "상품 선택..." : "수강권 선택..."}</option>
              {grantProducts.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {p.countSelectable ? priceSummary(p) : won(p.price)}{!p.onSale ? " (판매중지)" : ""}</option>
              ))}
            </select>

            {grantProducts.length === 0 && (
              <div className="perm-guide" style={{ margin: "0 0 10px" }}>
                {grantKind === "goods"
                  ? "지급할 수 있는 상품이 없어요. 상품 관리에서 대여/판매 상품을 먼저 만들어주세요."
                  : "지급할 수 있는 수강권이 없어요."}
              </div>
            )}

            {/* 지급 횟수 — 구매 횟수 선택형 상품만(고정 상품은 상품 정의 횟수로 지급) */}
            {(() => {
              const sel = grantProducts.find((p) => p.id === grantProductId);
              const choices = grantCountOptions(sel);
              if (choices.length === 0) return null;
              return (
                <>
                  <div className="menu-section-label" style={{ padding: "0 0 6px" }}>지급 횟수</div>
                  <select aria-label="지급 횟수" className="input-field" style={{ marginBottom: 10 }}
                    value={grantCount ?? ""} disabled={granting}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setGrantCount(n);
                      // 가격이 아직 기본값(1회가×이전 횟수)이면 새 횟수에 맞춰 갱신, 관리자가 직접 바꾼 값이면 유지
                      const dpPrev = defaultGrantPrice(sel, grantCount);
                      if (grantPrice === "" || Number(grantPrice) === dpPrev) {
                        const next = defaultGrantPrice(sel, n);
                        if (next != null) setGrantPrice(String(next));
                      }
                    }}>
                    {choices.map((n) => <option key={n} value={n}>{countOptionLabel({ count: n, price: tierPriceFor(sel!, n) ?? 0 })}</option>)}
                  </select>
                </>
              );
            })()}

            {/* 사이즈 — 상품에 sizes가 정의돼 있으면 필수(memberships.selected_size에 저장) */}
            {(() => {
              const sel = grantProducts.find((p) => p.id === grantProductId);
              if (!productNeedsSize(sel)) return null;
              return (
                <>
                  <div className="menu-section-label" style={{ padding: "0 0 6px" }}>사이즈</div>
                  <div className="mem-filters" style={{ padding: 0, marginBottom: 10 }}>
                    {sel!.sizes.map((sz) => (
                      <button key={sz} aria-pressed={grantSize === sz}
                        className={`filter-chip ${grantSize === sz ? "on" : ""}`} disabled={granting}
                        onClick={() => setGrantSize(sz)}>{sz}</button>
                    ))}
                  </div>
                </>
              );
            })()}

            <div className="menu-section-label" style={{ padding: "0 0 6px" }}>가격</div>
            <input aria-label="0원이면 서비스로 지급"
              className="input-field" type="number" min={0} style={{ marginBottom: 10 }}
              placeholder="0원이면 서비스로 지급" value={grantPrice} disabled={granting}
              onChange={(e) => {
                setGrantPrice(e.target.value);
                const n = Number(e.target.value);
                if (n === 0) setGrantMethod("service");
                else if (grantMethod === "service") setGrantMethod("card");
              }}
            />

            <div className="menu-section-label" style={{ padding: "0 0 6px" }}>결제방법</div>
            <div className="mem-filters" style={{ padding: 0, marginBottom: 10 }}>
              {Number(grantPrice) === 0 ? (
                <span className="filter-chip on">서비스(무상 지급)</span>
              ) : (
                (["card", "cash", "transfer"] as const).map((m) => (
                  <button aria-pressed={grantMethod === m}
                    key={m} className={`filter-chip ${grantMethod === m ? "on" : ""}`} disabled={granting}
                    onClick={() => setGrantMethod(m)}
                  >
                    {m === "card" ? "카드(센터 결제)" : m === "cash" ? "현금" : "계좌이체"}
                  </button>
                ))
              )}
            </div>

            {/* 2026-10-01(Batch C, C-10) — 요일/시간 선택형 상품은 관리자 발급에서도 선택을
                받는다(구매 플로우와 동일 원칙 — binding 누락된 membership 방지). */}
            {(() => {
              const product = grantProducts.find((p) => p.id === grantProductId);
              if (!product?.weekdaySelectable) return null;
              return (
                <>
                  <div className="menu-section-label" style={{ padding: "0 0 6px" }}>이용 요일</div>
                  {grantScheduleOptions === null ? (
                    <div className="perm-guide" style={{ margin: "0 0 10px" }}>요일 정보를 불러오는 중이에요…</div>
                  ) : grantScheduleOptions.days.length === 0 ? (
                    <div className="perm-guide" style={{ margin: "0 0 10px" }}>이 상품에 아직 요일이 지정된 예약조건이 없어요.</div>
                  ) : (
                    <>
                      <div className="mem-filters" style={{ marginBottom: 10 }}>
                        {grantScheduleOptions.days.map((d) => (
                          <button key={d} aria-pressed={grantScheduleDay === d}
                            className={`filter-chip ${grantScheduleDay === d ? "on" : ""}`}
                            onClick={() => { setGrantScheduleDay(d); setGrantScheduleTime(null); }}>
                            {DAYS[d]}요일
                          </button>
                        ))}
                      </div>
                      {product.timeSelectable && grantScheduleDay !== null && (
                        <>
                          <div className="menu-section-label" style={{ padding: "0 0 6px" }}>이용 시간</div>
                          <div className="mem-filters" style={{ marginBottom: 10 }}>
                            {(grantScheduleOptions.timesByDay[grantScheduleDay] ?? []).map((t) => (
                              <button key={t} aria-pressed={grantScheduleTime === t}
                                className={`filter-chip ${grantScheduleTime === t ? "on" : ""}`}
                                onClick={() => setGrantScheduleTime(t)}>
                                {t}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </>
              );
            })()}

            {Number(grantPrice) > 0 && (
              <div className="perm-guide" style={{ margin: "0 0 10px" }}>
                센터에서 직접 받은 금액을 기록하는 거예요. 온라인 결제(Toss)는 실행되지 않아요.
              </div>
            )}

            <div className="menu-section-label" style={{ padding: "0 0 6px" }}>관리자 메모 (회원에게 보이지 않음)</div>
            <input aria-label="예: 이벤트 당첨 증정"
              className="input-field" style={{ marginBottom: 10 }}
              placeholder="예: 이벤트 당첨 증정" value={grantMemo} disabled={granting}
              onChange={(e) => setGrantMemo(e.target.value)}
            />

            {Number(grantPrice) === 0 && (
              <div className="perm-guide" style={{ margin: "0 0 10px" }}>
                무상 지급은 매출 0원으로 기록돼요. 결제 내역에 "서비스"로 구분되어 남아요.
              </div>
            )}

            <div className="add-profile-actions">
              <button className="ghost-btn" disabled={granting} onClick={() => setGrantTarget(null)}>취소</button>
              <button
                className="primary-btn"
                disabled={
                  granting ||
                  grantBlockReason({
                    product: grantProducts.find((p) => p.id === grantProductId),
                    price: grantPrice, selectedSize: grantSize, scheduleDay: grantScheduleDay, scheduleTime: grantScheduleTime, selectedCount: grantCount,
                  }) !== null
                }
                onClick={handleGrant}
              >
                {granting ? "지급 중..." : "지급하기"}
              </button>
            </div>
          </div>
        </SheetOverlay>
      )}

      {/* 알림톡 발송 시트 — 회원 목록 다중 선택 또는 상세에서 1명 */}
      {alimtalkTargets && (
        <SheetOverlay className="sheet-overlay" swipeDismiss={!sendingAlimtalk} onClick={() => !sendingAlimtalk && setAlimtalkTargets(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">알림톡 보내기</div>
            <div className="perm-guide" style={{ margin: "0 0 10px" }}>
              {alimtalkTargets.length === 1
                ? `${alimtalkTargets[0].name}님에게 보내요.`
                : `선택한 ${alimtalkTargets.length}명에게 보내요.`}
              {" "}전화번호가 없는 회원은 자동으로 건너뜁니다.
            </div>
            <AlimtalkComposer blocks={alimtalkBlocks} onChange={setAlimtalkBlocks} disabled={sendingAlimtalk} />
            <div className="add-profile-actions">
              <button className="ghost-btn" disabled={sendingAlimtalk} onClick={() => setAlimtalkTargets(null)}>취소</button>
              <button className="primary-btn" disabled={sendingAlimtalk || !hasAlimtalkContent(alimtalkBlocks)} onClick={handleSendAlimtalk}>
                {sendingAlimtalk ? "발송 중..." : "발송"}
              </button>
            </div>
          </div>
        </SheetOverlay>
      )}
    </div>
  );
}
