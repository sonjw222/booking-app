// 날짜 선택 팝오버 같은 "앵커 기준 떠 있는 패널"의 위치 계산(순수 함수 — 단위 테스트로 검증한다).
// 기본은 앵커 아래, 공간이 모자라면 위, 둘 다 안 되면 뷰포트 안으로 밀어 넣는다(앵커와 겹칠 수 있음).
// 패널이 뷰포트보다 크면 maxHeight를 돌려줘 호출부가 내부 스크롤로 처리한다.

export type AnchorRect = { top: number; left: number; bottom: number; right: number };
export type PanelSize = { width: number; height: number };
export type ViewportSize = { width: number; height: number };

export type PopoverPosition = {
  top: number;
  left: number;
  placement: "bottom" | "top" | "overlay";
  /** 패널이 뷰포트(여백 제외)보다 클 때만 설정 */
  maxHeight?: number;
};

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

export function computePopoverPosition(
  anchor: AnchorRect,
  size: PanelSize,
  viewport: ViewportSize,
  gap = 8,
  margin = 8,
): PopoverPosition {
  const maxHeight = viewport.height - margin * 2;
  const height = Math.min(size.height, maxHeight);
  const spaceBelow = viewport.height - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;
  const left = clamp(anchor.left, margin, viewport.width - size.width - margin);
  const result: PopoverPosition = { top: 0, left, placement: "bottom" };
  if (height <= spaceBelow) result.top = anchor.bottom + gap;
  else if (height <= spaceAbove) { result.top = anchor.top - gap - height; result.placement = "top"; }
  else { result.top = clamp(anchor.bottom + gap, margin, viewport.height - height - margin); result.placement = "overlay"; }
  if (size.height > maxHeight) result.maxHeight = maxHeight;
  return result;
}
