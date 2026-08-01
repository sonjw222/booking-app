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

// 이미 존재하는 account에 새 센터를 등록(오너로 연결)한다.
//   - 회원가입 흐름: accounts/profiles 생성 직후 방금 만든 account.id로 호출
//   - 마이페이지 흐름: 이미 로그인된 본인 account.id로 호출
// 센터 status는 DB 기본값 'pending' 그대로 두어(schema.sql 주석: "가입 후 승인대기"),
// 기존 플랫폼 관리자 승인 흐름(app/admin/centers)을 그대로 재사용한다.
export async function registerCenterForAccount(
  accountId: string,
  input: CenterRegistrationInput
): Promise<{ centerId: string }> {
  const validationError = validateCenterRegistrationInput(input);
  if (validationError) throw new Error(validationError);

  const newCenterId = crypto.randomUUID();

  let licensePath = input.licenseFileName;
  if (input.licenseFile) {
    licensePath = await uploadBusinessLicense(input.licenseFile);
  }

  const { error: centerErr } = await supabase.from("centers").insert({
    id: newCenterId,
    name: input.name,
    address: input.address,
    phone: input.phone,
    business_number: input.businessNumber,
    business_license_url: licensePath,
    // status는 지정하지 않음 → DB 기본값 'pending' (플랫폼 관리자 승인 대기)
  });
  if (centerErr) throw new Error("센터 생성 중 문제가 발생했어요: " + centerErr.message);

  // 센터-매니저 연결을 먼저 만든다(이 행이 있어야 이후 조회 정책의 "내 센터" 조건이 충족됨).
  // 센터를 직접 만든 사람이므로 manager_centers.status는 바로 active — 이건 centers.status(승인 대기)와는
  // 별개 필드다. ACL-005: /manager 진입 판정은 이 manager_centers.status만 보므로, 승인 전 센터의
  // 오너도 기존과 동일하게 관리자 모드에는 즉시 진입할 수 있다(기존 동작 유지, 임의 변경 없음).
  const { error: mcErr } = await supabase.from("manager_centers").insert({
    account_id: accountId,
    center_id: newCenterId,
    status: "active",
  });
  if (mcErr) throw new Error("매니저 연결 중 문제가 발생했어요: " + mcErr.message);

  // 방금 만든 센터의 기본 역할 중 '스튜디오 오너'를 찾아 연결한다.
  const { data: ownerRole, error: roleErr } = await supabase
    .from("center_roles")
    .select("id")
    .eq("center_id", newCenterId)
    .eq("role_key", "owner")
    .single();
  if (roleErr || !ownerRole) {
    throw new Error("오너 역할 연결 중 문제가 발생했어요: " + (roleErr?.message ?? "역할을 찾을 수 없어요"));
  }

  const { error: updErr } = await supabase
    .from("manager_centers")
    .update({ role_id: ownerRole.id })
    .eq("account_id", accountId)
    .eq("center_id", newCenterId);
  if (updErr) throw new Error("오너 역할 연결 중 문제가 발생했어요: " + updErr.message);

  return { centerId: newCenterId };
}
