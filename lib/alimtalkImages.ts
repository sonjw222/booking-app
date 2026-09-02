/*
  알림톡/문자 발송 컴포저용 사진 업로드 (Supabase Storage)
  - 버킷: alimtalk-images (공개, add_alimtalk_storage.sql)
  - lib/profiles.ts의 uploadAvatar()와 동일한 업로드 패턴
*/

import { supabase } from "./supabaseClient";

const BUCKET = "alimtalk-images";

export async function uploadAlimtalkImage(file: File): Promise<string> {
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false });
  if (error) throw new Error("사진 업로드에 실패했어요: " + error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
