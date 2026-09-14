import { cookies } from "next/headers";
import ManagerChrome from "../components/ManagerChrome";
import ManagerNav from "../components/ManagerNav";
import PendingApprovalBanner from "../components/PendingApprovalBanner";
import { parseCanSeeMembersCookie } from "../../lib/roles";

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  // 릴리스 폴리시 배치(2026-09-14) — ManagerNav.tsx 주석 참고: 클라이언트 라우팅이 없어
  // 매 관리자 탭 전환이 전체 페이지 재로드이므로, 쿠키를 여기(서버 컴포넌트)에서 미리
  // 읽어 최초 렌더링 값으로 내려줘야 "탭 3개→4개" 깜빡임이 없어진다.
  const cookieStore = await cookies();
  const initialCanSeeMembers = parseCanSeeMembersCookie(cookieStore.get("manager_nav_can_see_members")?.value);
  return (
    <div className="manager-v3">
      <ManagerChrome />
      <PendingApprovalBanner />
      <main className="manager-v3-content">{children}</main>
      <ManagerNav initialCanSeeMembers={initialCanSeeMembers} />
    </div>
  );
}
