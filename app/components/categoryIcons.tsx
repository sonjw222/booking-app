/*
  종목(카테고리) 아이콘 매핑 — 홈 화면 "종목 둘러보기"(app/page.tsx)에서 쓰던 것을 여기로
  옮겨 단일 출처로 만들었다(릴리스 폴리시 배치 8차, 2026-09-18, 5번). 운영자 모드 "종목
  관리"(app/admin/categories/page.tsx)가 이모지 대신 같은 아이콘을 그대로 재사용하기
  위함 — 새 이미지 asset을 만들지 않는다.

  CATEGORY_IMAGES(사용자 제공 디자인 PNG, /public/icons/categories/*)가 우선이고, 아직
  전용 이미지가 없는 종목은 CATEGORY_ICONS(UiIcon 단색 라인 아이콘)로 대체, 그마저도 없는
  (운영자가 새로 추가한) 종목은 "grid"(기본 아이콘)로 안전하게 폴백한다 — 아이콘 매핑이
  없다고 화면이 깨지면 안 된다.
*/
import { useState } from "react";
import UiIcon, { type IconName } from "./UiIcon";

export const CATEGORY_ICONS: Record<string, IconName> = {
  피겨스케이팅: "skate", 필라테스: "pilates", 발레: "ballet", 리듬체조: "rhythm",
  요가: "yoga", 복싱: "boxing", 수영: "swim", 골프: "golf",
};

export const CATEGORY_IMAGES: Record<string, string> = {
  피겨스케이팅: "/icons/categories/skate.png", 필라테스: "/icons/categories/pilates.png",
  발레: "/icons/categories/ballet.png", 리듬체조: "/icons/categories/rhythm.png",
  요가: "/icons/categories/yoga.png", 복싱: "/icons/categories/boxing.png",
  수영: "/icons/categories/swim.png", 골프: "/icons/categories/golf.png",
  테니스: "/icons/categories/tennis.png",
};

export const DEFAULT_CATEGORY_ICON: IconName = "grid";

export function categoryIconFor(label: string): { image: string | null; icon: IconName } {
  return {
    image: CATEGORY_IMAGES[label] ?? null,
    icon: CATEGORY_ICONS[label] ?? DEFAULT_CATEGORY_ICON,
  };
}

// 이미지가 있는 종목은 이미지를, 없으면(또는 로드 실패 시) UiIcon으로 안전하게 대체한다.
// 홈 화면(app/page.tsx)은 기존 렌더링을 그대로 유지하되, 운영자 종목 관리처럼 "icon load
// fail 시 layout fallback"이 명시적으로 필요한 화면에서 이 컴포넌트를 쓴다.
export default function CategoryIcon({ label, size = 27 }: { label: string; size?: number }) {
  const { image, icon } = categoryIconFor(label);
  const [failed, setFailed] = useState(false);
  if (image && !failed) {
    return <img src={image} alt="" width={size} height={size} onError={() => setFailed(true)} />;
  }
  return <UiIcon name={icon} size={size} />;
}
