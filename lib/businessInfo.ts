/*
  사업자 정보 — 단일 출처. app/legal/business/page.tsx(사업자 정보 전용 페이지)와
  app/manager/subscription/page.tsx(플랫폼 구독 상품 페이지의 하단 사업자정보 — 토스
  자동결제 계약 심사가 요구하는 "홈페이지 하단 사업자정보") 두 곳에서 같은 값을 쓴다.
  값이 하나라도 어긋나면 심사에서 "사업자등록증과 불일치"로 반려될 수 있으므로 여기
  한 곳에서만 관리한다.
*/

export const BUSINESS_INFO = {
  serviceName: "모하빗",
  companyName: "손장욱",
  ceoName: "손장욱",
  businessRegNo: "589-77-00451",
  address: "경기도 성남시 분당구 중앙공원로 20, 420동 702호",
  customerServicePhone: "010-6505-8700",
  email: "sonjw222@naver.com",
} as const;
