"use client";

/*
  회원 화면 전용 하단 네비게이션을 최상위 레이아웃에서 한 번만 마운트한다.
  이전에는 BottomNav를 쓰는 18개 페이지가 각자 <BottomNav />를 렌더링해서, 페이지를
  옮길 때마다(같은 회원 화면 사이 이동이어도) 컴포넌트가 통째로 새로 마운트되며
  "예약"/"내 예약" 탭 판정이 다시 로딩 상태로 돌아가 짧게 깜빡였다. 여기서 한 번만
  마운트해두면 회원 화면 사이를 이동해도 이 컴포넌트는 유지되고, 판정도 다시 로딩
  상태로 돌아가지 않는다(최초 진입 시에만 잠깐 로딩 상태를 거침).
*/

import { usePathname } from "next/navigation";
import BottomNav from "./BottomNav";

const MEMBER_NAV_PREFIXES = [
  "/cart", "/reservation", "/mypage", "/purchases", "/inquiries",
  "/profiles", "/notifications", "/search", "/category", "/center",
  "/checkout", "/settings", "/my-reservations",
];

// 마이페이지 안에서도 센터 등록 화면(/mypage/register-center)은 원래부터 전체화면
// 등록 플로우라 하단 네비게이션이 없었다 — "/mypage" 프리픽스 매칭에서 제외한다.
const EXCLUDED_ROUTES = ["/mypage/register-center"];

function isMemberNavRoute(pathname: string): boolean {
  if (EXCLUDED_ROUTES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return false;
  if (pathname === "/") return true;
  return MEMBER_NAV_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export default function GlobalBottomNav() {
  const pathname = usePathname();
  if (!isMemberNavRoute(pathname)) return null;
  return <BottomNav />;
}
