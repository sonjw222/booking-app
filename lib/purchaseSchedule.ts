/*
  구매 시 요일/시간 선택형 수강권(products.weekday_selectable / time_selectable)의 구매 가능 판정(순수 함수).
  저장된 상품 설정이 source of truth다 — 예약조건이 있다고 선택형으로 간주하지도, 없다고 선택을 숨기지도 않는다.
  결제 방식(direct/PG)과 무관하게 handlePay()에서 분기 전에 이 판정을 먼저 적용한다.
*/
import type { SelectableSchedule } from "./passes";

export type PurchaseScheduleProduct = { kind?: string; weekdaySelectable: boolean; timeSelectable: boolean };

export type PurchaseScheduleState =
  | { required: false; blocked: false; message: null }
  | { required: true; blocked: boolean; message: string | null; reason: "loading" | "load_failed" | "no_options" | "pick_day" | "no_times" | "pick_time" | "ok" };

export function purchaseScheduleState(
  product: PurchaseScheduleProduct | null,
  options: SelectableSchedule | null,
  optionsFailed: boolean,
  day: number | null,
  time: string | null,
): PurchaseScheduleState {
  if (!product || product.kind === "goods" || !product.weekdaySelectable) return { required: false, blocked: false, message: null };
  if (optionsFailed) return { required: true, blocked: true, reason: "load_failed", message: "수강 요일 정보를 불러오지 못했어요. 새로고침 후 다시 시도해주세요." };
  if (options === null) return { required: true, blocked: true, reason: "loading", message: null };
  if (options.days.length === 0) {
    return { required: true, blocked: true, reason: "no_options", message: "아직 선택 가능한 요일이 설정되지 않아 구매할 수 없어요. 센터에 문의해주세요." };
  }
  if (day === null) return { required: true, blocked: true, reason: "pick_day", message: "이용할 요일을 선택해 주세요." };
  if (product.timeSelectable) {
    const times = options.timesByDay[day] ?? [];
    if (times.length === 0) return { required: true, blocked: true, reason: "no_times", message: "이 요일엔 선택 가능한 시간이 설정되지 않아 구매할 수 없어요. 센터에 문의해주세요." };
    if (!time) return { required: true, blocked: true, reason: "pick_time", message: "이용할 시간을 선택해 주세요." };
  }
  return { required: true, blocked: false, message: null, reason: "ok" };
}
