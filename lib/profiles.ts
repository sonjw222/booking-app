/*
  프로필 관리 데이터 함수
  - 한 계정 아래 여러 프로필(수강 주체)을 추가/삭제/조회
  - is_primary 프로필은 삭제 불가 (계정 본인)
  - "활성 프로필"은 어느 프로필로 예약할지 선택하는 값 (브라우저에 저장 X → React 상태/URL로 관리)
*/

import { supabase } from "./supabaseClient";
import { getMyAccountId as getMyAccountIdBase } from "./authAccount";

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
  const accountId = await getMyAccountIdBase();
  if (!accountId) throw new Error("계정 정보를 찾을 수 없어요");
  return accountId;
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

// profiles.avatar_url에 저장된 값에서 "avatars" 버킷 안의 object key만 뽑아낸다.
// supabase/functions/delete-account/index.ts의 avatarObjectKey와 동일 로직(그쪽은 계정
// 탈퇴 시 admin 클라이언트로 지우고, 여기는 재업로드/가족 프로필 삭제 시 사용자 클라이언트로
// 지운다 — 소유 판별 기준은 같아야 한다).
//   - 이미 순수 object key("uuid.jpg")로 저장된 게 표준 형태(아래 uploadAvatar).
//   - "http..."로 시작하면 getPublicUrl()이 만든 전체 URL(레거시/시딩 데이터 가능성) —
//     "/storage/v1/object/public/avatars/" 마커 뒤의 경로만 이 버킷 소유로 인정한다.
//     다른 호스트/버킷을 가리키는 외부 URL(기본 이미지 등)은 우리가 지울 수 있는 object가
//     아니므로 null을 반환해 건너뛴다 — 소유를 확실히 판별 못하는 파일은 임의로 지우지 않는다.
function avatarObjectKey(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("http")) return raw;
  const marker = "/storage/v1/object/public/avatars/";
  const idx = raw.indexOf(marker);
  if (idx === -1) return null;
  try {
    return decodeURIComponent(raw.slice(idx + marker.length));
  } catch {
    return null;
  }
}

// 이전 avatar가 실제로 교체/제거됐을 때만(새 값과 다를 때만) 이전 Storage object를 지운다.
// best-effort — 실패해도 예외를 던지지 않는다(호출부의 저장 흐름을 막을 이유가 아니고,
// 이미 DB는 새 값으로 갱신이 끝난 뒤라 실패해도 orphan 하나만 남을 뿐 데이터 손실은 없음).
// storage.objects의 "아바타 삭제" RLS 정책(add_avatar_storage_delete_policy.sql)이
// owner = auth.uid()만 허용하므로, 이 키가 실제로 다른 사용자 소유여도 서버에서 한 번 더
// 막힌다(방어 이중화).
async function cleanupOldAvatarIfReplaced(previous: string | null, next: string | null): Promise<void> {
  if (!previous || previous === next) return;
  const key = avatarObjectKey(previous);
  if (!key) return;
  const { error } = await supabase.storage.from("avatars").remove([key]);
  if (error) {
    console.error(`이전 아바타 파일 삭제 실패(orphan 가능성, 수동 확인 필요): ${key} — ${error.message}`);
  }
}

// 프로필 수정 (이름·선택정보)
export async function updateProfile(profileId: string, edit: ProfileEdit): Promise<void> {
  // DB 업데이트 *전에* 현재 값을 읽어둔다 — 실패 안전성 순서: 새 사진은 호출부
  // (uploadAvatar)가 이미 별도로 올려둔 뒤이므로, 여기서는 "DB 업데이트가 실제로
  // 성공했을 때만" 이전 파일을 지운다. 이 조회 자체가 실패해도(RLS 등) 아래에서
  // previousAvatarUrl이 null로 남아 cleanup이 조용히 건너뛰어질 뿐, 저장 자체는 막지 않는다.
  const { data: before } = await supabase.from("profiles").select("avatar_url").eq("id", profileId).maybeSingle();
  const previousAvatarUrl = (before as any)?.avatar_url ?? null;

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

  // DB 업데이트가 성공한 *뒤에만* 이전 파일을 지운다 — 위 update()가 실패해 예외를
  // 던지면 이 줄에 도달하지 않으므로 이전 avatar는 그대로 남는다(데이터 손실 없음).
  await cleanupOldAvatarIfReplaced(previousAvatarUrl, edit.avatarUrl ?? null);
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
  // 대표 프로필은 삭제 못하게 프론트에서도 막지만, 서버에서도 확인. avatar_url도 같이
  // 읽어둔다 — 아래에서 soft-delete가 avatar_url을 null로 덮어쓰기 *전에* Storage object를
  // 지워야 하므로(순서는 supabase/functions/delete-account의 P0-2 패턴과 동일).
  const { data, error: getErr } = await supabase
    .from("profiles")
    .select("is_primary, avatar_url")
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

  // soft-delete가 성공한 *뒤에만* Storage object를 지운다 — best-effort(실패해도 삭제
  // 자체는 이미 끝난 상태이므로 예외를 던지지 않음, orphan 가능성만 로그로 남김).
  await cleanupOldAvatarIfReplaced((data as any).avatar_url ?? null, null);
}
