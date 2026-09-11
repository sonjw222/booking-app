/*
  Privacy #6/#7 — avatar 재업로드 시 orphan 방치(#6), 가족 프로필 삭제 시 avatar
  미삭제(#7) 검증. lib/profiles.ts가 실제로 export하는 uploadAvatar/updateProfile/
  deleteProfile을 그대로 호출해 Storage object가 교체/삭제 시점에 맞춰 정리되는지
  확인한다(재구현하지 않음 — 실제 코드를 검증).

  ⚠ add_avatar_storage_delete_policy.sql(storage.objects DELETE 정책)이 적용되기
  전에는 Storage 삭제 호출이 RLS로 막혀 orphan이 그대로 남는다 — "이전 object가
  실제로 지워졌는지" 단언(case 5, case 8)은 그 마이그레이션 적용 후에만 통과한다.
  적용 전에는 업로드/DB 저장 자체는 정상 동작하고 cleanup만 best-effort로 조용히
  실패한다(예외를 던지지 않음 — lib/profiles.ts 주석 참고).

  이 파일은 lib/profiles.ts가 쓰는 공유 싱글턴(lib/supabaseClient.ts)을 직접
  로그인시켜 실제 클라이언트 코드 경로 그대로 호출한다 — vitest.integration.config.ts의
  fileParallelism:false로 다른 테스트 파일과 겹치지 않는다(setup.ts 상단 주석 참고).
*/
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { uploadAvatar, updateProfile, deleteProfile, fetchProfiles, addProfile, type ProfileEdit } from "../../lib/profiles";
import { getFixtureAdminClient, requireEnv } from "./setup";

function emptyEdit(overrides: Partial<ProfileEdit>): ProfileEdit {
  return {
    nickname: "", label: "", birthDate: "", gender: "", shoeSize: "", clothSize: "",
    address: "", phone: "", memo: "", avatarUrl: null,
    ...overrides,
  };
}

function tinyPngFile(name: string): File {
  // 유효한 최소 PNG 헤더 바이트 — 실제 이미지 렌더링을 검증하는 게 아니라 업로드/삭제
  // 경로만 확인하면 되므로 내용 자체는 의미 없다.
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  return new File([bytes], name, { type: "image/png" });
}

describe("avatar Storage object 정리 (Privacy #6/#7)", () => {
  requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `qa-avatar-${runId}@example.com`;
  const password = `Qa-avatar-pw-${runId}`;
  const phone = `010-${runId.slice(0, 4)}-${runId.slice(-4).padStart(4, "0")}`;

  let authId = "";
  let accountId = "";
  let primaryProfileId = "";
  // afterAll에서 최후 방어로 지우는 용도(정상 흐름이면 이미 개별 단언에서 지워졌어야 함).
  const uploadedKeys: string[] = [];

  async function objectExists(key: string): Promise<boolean> {
    const idx = key.lastIndexOf("/");
    const dir = idx === -1 ? "" : key.slice(0, idx);
    const name = idx === -1 ? key : key.slice(idx + 1);
    const admin = getFixtureAdminClient();
    const { data } = await admin.storage.from("avatars").list(dir, { search: name });
    return !!(data ?? []).some((f) => f.name === name);
  }

  beforeAll(async () => {
    const admin = getFixtureAdminClient();
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`테스트 계정 생성 실패: ${created.error?.message}`);
    authId = created.data.user.id;

    const acc = await admin.from("accounts").insert({ auth_id: authId, name: "QA 아바타", phone, is_member: true }).select("id").single();
    if (acc.error || !acc.data) throw new Error(`accounts 생성 실패: ${acc.error?.message}`);
    accountId = acc.data.id as string;

    const prof = await admin.from("profiles").insert({ account_id: accountId, name: "QA 아바타 본인", is_primary: true }).select("id").single();
    if (prof.error || !prof.data) throw new Error(`profiles 생성 실패: ${prof.error?.message}`);
    primaryProfileId = prof.data.id as string;

    await supabase.auth.signOut({ scope: "local" });
    const signIn = await supabase.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`로그인 실패: ${signIn.error.message}`);
  });

  afterAll(async () => {
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    const admin = getFixtureAdminClient();
    if (uploadedKeys.length > 0) await admin.storage.from("avatars").remove(uploadedKeys).catch(() => {});
    if (accountId) await admin.from("accounts").delete().eq("id", accountId).then(() => {}, () => {});
    if (authId) await admin.auth.admin.deleteUser(authId).catch(() => {});
  });

  it("최초 업로드 → avatar_url이 저장되고 object가 실제로 존재한다 (case 4)", async () => {
    const key1 = await uploadAvatar(tinyPngFile("first.png"));
    uploadedKeys.push(key1);
    await updateProfile(primaryProfileId, emptyEdit({ avatarUrl: key1 }));
    expect(await objectExists(key1)).toBe(true);
  });

  it("재업로드 → 새 object는 존재하고 이전 object는 지워진다 (case 5)", async () => {
    const key1 = await uploadAvatar(tinyPngFile("before.png"));
    uploadedKeys.push(key1);
    await updateProfile(primaryProfileId, emptyEdit({ avatarUrl: key1 }));
    expect(await objectExists(key1)).toBe(true);

    const key2 = await uploadAvatar(tinyPngFile("after.png"));
    uploadedKeys.push(key2);
    await updateProfile(primaryProfileId, emptyEdit({ avatarUrl: key2 }));

    expect(await objectExists(key2)).toBe(true);
    // ⚠ add_avatar_storage_delete_policy.sql 적용 전이면 이 단언만 실패한다(위 파일 상단 주석 참고).
    expect(await objectExists(key1)).toBe(false);
  });

  it("avatar 없는 프로필을 일반 필드만 수정해도 에러 없이 저장된다 (case 6)", async () => {
    await expect(updateProfile(primaryProfileId, emptyEdit({ avatarUrl: null, memo: "메모만 변경" }))).resolves.toBeUndefined();
  });

  it("외부 URL(우리 버킷 소유가 아닌 값)은 재업로드해도 지우려 하지 않는다 (case 7)", async () => {
    const externalUrl = "https://example.com/not-our-bucket.png";
    await updateProfile(primaryProfileId, emptyEdit({ avatarUrl: externalUrl }));

    const key = await uploadAvatar(tinyPngFile("replace-external.png"));
    uploadedKeys.push(key);
    // avatarObjectKey()가 이 외부 URL을 우리 버킷 key로 판별 못해(마커 불일치) cleanup을
    // 건너뛴다 — 예외 없이 끝나고 새로 올린 object는 멀쩡히 남아있어야 한다.
    await expect(updateProfile(primaryProfileId, emptyEdit({ avatarUrl: key }))).resolves.toBeUndefined();
    expect(await objectExists(key)).toBe(true);
  });

  it("가족 프로필 삭제 시 avatar object도 함께 지워진다 (case 8)", async () => {
    await addProfile("QA 가족", "", "");
    const profiles = await fetchProfiles();
    const family = profiles.find((p) => p.name === "QA 가족" && !p.isPrimary);
    if (!family) throw new Error("가족 프로필 생성 확인 실패");

    const key = await uploadAvatar(tinyPngFile("family.png"));
    uploadedKeys.push(key);
    await updateProfile(family.id, emptyEdit({ avatarUrl: key }));
    expect(await objectExists(key)).toBe(true);

    await deleteProfile(family.id);
    // ⚠ add_avatar_storage_delete_policy.sql 적용 전이면 이 단언만 실패한다.
    expect(await objectExists(key)).toBe(false);
  });

  it("avatar 없는 가족 프로필을 삭제해도 에러 없이 끝난다 (case 9)", async () => {
    await addProfile("QA 가족 무사진", "", "");
    const profiles = await fetchProfiles();
    const family = profiles.find((p) => p.name === "QA 가족 무사진" && !p.isPrimary);
    if (!family) throw new Error("가족 프로필 생성 확인 실패");
    await expect(deleteProfile(family.id)).resolves.toBeUndefined();
  });
});
