/* 사업장 소재지(사업자등록증 기준, 자택 주소). 현재 공개 범위: /legal/business(사업자 정보 전용 페이지)와 관리자 구독 화면. 홈·공개 상품 하단 표시는
   환경변수 NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER === "true" 일 때만(기본 꺼짐 — NICEPAY 카드사 심사 승인 후 Vercel 환경변수로만 켠다, 코드 변경 불필요).
   푸터 쪽은 이 값을 `process.env.NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER === "true" && …{BUSINESS_ADDRESS}` 꼴로 직접 참조해, 꺼진 빌드에서는 분기가 제거되어 번들에 주소가 실리지 않게 한다. */
// 별도 모듈인 이유: BUSINESS_INFO 와 같은 파일에 두면 홈·공개 화면이 BUSINESS_INFO 를 import 할 때 번들에 이 문자열도 함께 실린다(푸터 표시가 꺼져 있어도).
export const BUSINESS_ADDRESS = "경기도 성남시 분당구 중앙공원로 20, 420동 702호";
