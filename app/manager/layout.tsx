import { cookies } from "next/headers";
import ManagerChrome from "../components/ManagerChrome";
import ManagerNav from "../components/ManagerNav";
import PendingApprovalBanner from "../components/PendingApprovalBanner";
import { parseCanSeeMembersCookie, parseManagerNavStateCookie } from "../../lib/roles";

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  // 릴리스 폴리시 배치(2026-09-14) — ManagerNav.tsx 주석 참고: 클라이언트 라우팅이 없어
  // 매 관리자 탭 전환이 전체 페이지 재로드이므로, 쿠키를 여기(서버 컴포넌트)에서 미리
  // 읽어 최초 렌더링 값으로 내려줘야 "탭 3개→4개" 깜빡임이 없어진다.
  const cookieStore = await cookies();
  const initialCanSeeMembers = parseCanSeeMembersCookie(cookieStore.get("manager_nav_can_see_members")?.value);
  // 안정화 배치(2026-09-22) — 위는 "회원" 탭 하나만 캐싱한다. 나머지 15개 이상 권한
  // 게이트 메뉴(매출·결제, 스태프·권한, 룸 관리 등)까지 첫 페인트부터 정확하게 그리기
  // 위해 오너 여부 + 보유 권한 키 전체를 캐싱한 일반화된 쿠키를 함께 읽는다
  // (lib/roles.ts 주석 참고).
  const initialManagerNavState = parseManagerNavStateCookie(cookieStore.get("manager_nav_state")?.value);
  return (
    <div className="manager-v3">
      <ManagerChrome />
      <PendingApprovalBanner />
      <main className="manager-v3-content">{children}</main>
      <ManagerNav initialCanSeeMembers={initialCanSeeMembers} initialNavState={initialManagerNavState} />
    </div>
  );
}
