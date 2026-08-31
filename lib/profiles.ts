/*
  프로필 관리 데이터 함수
  - 한 계정 아래 여러 프로필(수강 주체)을 추가/삭제/조회
  - is_primary 프로필은 삭제 불가 (계정 본인)
  - "활성 프로필"은 어느 프로필로 예약할지 선택하는 값 (브라우저에 저장 X → React 상태/URL로 관리)
*/

import { supabase } from "./supabaseClient";

export type ProfileRow = {
  id: string;
  name: string;
  nickname: string | null;
  label: string | null;
  birthDate: string | null;
  gender: string | null;
  shoeSize: string | null;
  clothSize: string | null;
  address: string | null;
  phone: string | null;
  avatarUrl: string | null;
  memo: string | null;
  isPrimary: boolean;
};

async function getMyAccountId(): Promise<string> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw new Error("로그인이 필요해요");
  const { data, error } = await supabase
    .from("accounts")
    .select("id")
    .eq("auth_id", authData.user.id)
    .single();
  if (error || !data) throw new Error("계정 정보를 찾을 수 없어요");
  return data.id;
}

export async function fetchProfiles(): Promise<ProfileRow[]> {
  const accountId = await getMyAccountId();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, nickname, label, birth_date, gender, shoe_size, cloth_size, address, phone, avatar_url, memo, is_primary")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw new Error("프로필을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((p: any) => ({
    id: p.id,
    name: p.name,
    nickname: p.nickname,
    label: p.label,
    birthDate: p.birth_date,
    gender: p.gender,
    shoeSize: p.shoe_size,
    clothSize: p.cloth_size ?? null,
    address: p.address ?? null,
    phone: p.phone,
    avatarUrl: p.avatar_url,
    memo: p.memo,
    isPrimary: p.is_primary,
  }));
}

export type ProfileEdit = {
  nickname: string;
  label: string;
  birthDate: string;
  gender: string;
  shoeSize: string;
  clothSize: string;
  address: string;
  phone: string;
  memo: string;
  avatarUrl: string | null;
};

// 프로필 수정 (이름·선택정보)
export async function updateProfile(profileId: string, edit: ProfileEdit): Promise<void> {
  const patch: any = {
    nickname: edit.nickname || null,
    label: edit.label || null,
    birth_date: edit.birthDate || null,
    gender: edit.gender || null,
    shoe_size: edit.shoeSize || null,
    cloth_size: edit.clothSize || null,
    address: edit.address || null,
    phone: edit.phone || null,
    memo: edit.memo || null,
    avatar_url: edit.avatarUrl || null,
  };

  const { error } = await supabase.from("profiles").update(patch).eq("id", profileId);
  if (error) throw new Error("프로필 수정에 실패했어요: " + error.message);
}

// 프로필 사진 업로드 → Storage 경로 반환
export async function uploadAvatar(file: File): Promise<string> {
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file, { upsert: false });
  if (error) throw new Error("사진 업로드에 실패했어요: " + error.message);
  return path;
}

// 프로필 사진 열람 URL (public 버킷이면 public URL)
export function avatarPublicUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return data?.publicUrl ?? null;
}

export async function addProfile(name: string, label: string, birthDate: string): Promise<void> {
  const accountId = await getMyAccountId();
  const { error } = await supabase.from("profiles").insert({
    account_id: accountId,
    name,
    label: label || null,
    birth_date: birthDate || null,
    is_primary: false,
  });
  if (error) throw new Error("프로필 추가에 실패했어요: " + error.message);
}

// 실제 행을 지우지 않고 개인정보만 익명화 + deleted_at을 채운다(계정 탈퇴와 동일한 이유 —
// reservations.profile_id가 cascade 없는 FK라 예약 이력이 하나라도 있으면 진짜 DELETE는
// 항상 실패했다. supabase/functions/delete-account의 익명화 패턴을 프로필 단위로 재사용).
export async function deleteProfile(profileId: string): Promise<void> {
  // 대표 프로필은 삭제 못하게 프론트에서도 막지만, 서버에서도 확인
  const { data, error: getErr } = await supabase
    .from("profiles")
    .select("is_primary")
    .eq("id", profileId)
    .single();
  if (getErr || !data) throw new Error("프로필을 찾을 수 없어요");
  if (data.is_primary) throw new Error("대표 프로필은 삭제할 수 없어요");

  const { error } = await supabase
    .from("profiles")
    .update({
      name: "삭제된 프로필", nickname: null, label: null, birth_date: null, gender: null,
      shoe_size: null, cloth_size: null, address: null, phone: null, avatar_url: null, memo: null,
      deleted_at: new Date().toISOString(),
    })
    .eq("id", profileId);
  if (error) throw new Error("삭제에 실패했어요: " + error.message);
}
