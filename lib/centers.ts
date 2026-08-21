/*
  센터 등록 공용 로직 (회원가입의 "센터 운영자" 흐름 / 마이페이지의 "내 센터 등록하기" 흐름
  둘 다 여기 하나의 검증·저장 로직만 사용한다 — app/login/page.tsx의 handleSignup()과
  app/mypage/register-center/page.tsx가 동일하게 호출한다).
*/

import { supabase } from "./supabaseClient";
import { uploadBusinessLicense } from "./storage";

export type CenterRegistrationInput = {
  name: string;
  address: string;
  phone: string;
  businessNumber: string;
  licenseFile: File | null;
  licenseFileName: string;
};

// 필수값 검증만 수행(부수효과 없음) — 회원가입 흐름은 계정 생성 전에 이 함수로 먼저
// 검증해 실패 시 아무 것도 만들지 않는다(기존 동작 유지).
export function validateCenterRegistrationInput(input: CenterRegistrationInput): string | null {
  if (!input.name.trim()) return "센터 이름을 입력해주세요";
  if (!input.address.trim()) return "센터 주소를 입력해주세요";
  if (!input.phone.trim()) return "센터 대표번호를 입력해주세요";
  if (!input.businessNumber.trim()) return "사업자등록번호를 입력해주세요";
  if (!input.licenseFileName.trim()) return "사업자등록증을 첨부해주세요";
  return null;
}

// 지금 로그인된 계정에 새 센터를 등록(오너로 연결)한다.
//   - 회원가입 흐름: accounts/profiles 생성 직후, 같은 세션으로 호출
//   - 마이페이지 흐름: 이미 로그인된 본인 세션으로 호출
// centers insert → manager_centers insert → 오너 역할 조회/연결을 하나의 트랜잭션으로
// 묶은 register_center_for_account_safe() RPC를 호출한다(P2-11) — 계정은 RPC 안에서
// auth.uid() 기준으로 직접 확인하므로 accountId를 인자로 받지 않는다. 사업자등록번호
// 중복은 centers.business_number의 unique 인덱스가 막고, RPC가 그 경우 "이미 등록된
// 사업자등록번호예요" 메시지로 변환해 던진다(add_register_center_for_account_safe_rpc.sql).
export async function registerCenterForAccount(
  input: CenterRegistrationInput
): Promise<{ centerId: string }> {
  const validationError = validateCenterRegistrationInput(input);
  if (validationError) throw new Error(validationError);

  let licensePath = input.licenseFileName;
  if (input.licenseFile) {
    licensePath = await uploadBusinessLicense(input.licenseFile);
  }

  const { data, error } = await supabase.rpc("register_center_for_account_safe", {
    p_name: input.name,
    p_address: input.address,
    p_phone: input.phone,
    p_business_number: input.businessNumber,
    p_business_license_url: licensePath,
  });
  if (error) throw new Error(error.message);

  return { centerId: data as string };
}
