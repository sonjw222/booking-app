/*
  사업자등록증 파일 업로드 (Supabase Storage)
  - 버킷: business-licenses (비공개)
  - 업로드 후 파일 경로를 반환 → centers.business_license_url 에 저장
  - 운영자는 서명된 URL로 파일을 열람
*/

import { supabase } from "./supabaseClient";

const BUCKET = "business-licenses";

// 파일 업로드 → 저장된 경로(path) 반환
export async function uploadBusinessLicense(file: File): Promise<string> {
  // 확장자 유지, 고유 파일명 생성
  const ext = file.name.split(".").pop() ?? "dat";
  const path = `${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false });
  if (error) throw new Error("파일 업로드에 실패했어요: " + error.message);

  return path;
}

// 저장된 경로 → 임시 열람용 서명 URL (운영자용, 유효기간 60분)
export async function getBusinessLicenseUrl(path: string): Promise<string | null> {
  if (!path) return null;
  // 이미 완전한 URL(과거 데이터)이면 그대로
  if (path.startsWith("http")) return path;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 3600);
  if (error) return null;
  return data?.signedUrl ?? null;
}
