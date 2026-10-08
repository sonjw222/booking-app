import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 버킷 MIME/크기 제한 migration이 앱의 실제 업로드와 충돌하지 않는지 정적으로 고정한다(DB에는 접속하지 않는다).
const read = (f: string) => readFileSync(f, "utf8");
const code = (s: string) => s.replace(/^\s*--.*$/gm, "");
const mime = code(read("fix_storage_bucket_mime_limits_20261008.sql"));
const size = code(read("fix_storage_bucket_size_limits_20261008.sql"));

// app/ 아래 모든 <input type="file" ...> 와 그 accept 값을 수집한다.
const files = execSync(`grep -rln 'type="file"' app || true`, { encoding: "utf8" }).split("\n").filter(Boolean);
const inputs = files.flatMap((f) => {
  const src = read(f);
  return [...src.matchAll(/<input\b[^>]*type="file"[^>]*>/g)].map((m) => ({ file: f, tag: m[0], accept: (m[0].match(/accept="([^"]*)"/) ?? [])[1] }));
});

describe("storage 버킷 제한 ↔ 앱 업로드 호환", () => {
  it("모든 file input이 accept를 가지며 이미지(image/*) 또는 사업자등록증(image/*,.pdf)뿐이다", () => {
    expect(inputs.length).toBeGreaterThanOrEqual(8);
    for (const i of inputs) expect(["image/*", "image/*,.pdf"], `${i.file}: ${i.tag}`).toContain(i.accept);
  });
  it("PDF를 받는 입력은 사업자등록증 폼 하나뿐이고, 업로드 대상은 business-licenses 버킷이다", () => {
    const pdf = inputs.filter((i) => i.accept === "image/*,.pdf");
    expect(pdf.map((i) => i.file)).toEqual(["app/components/CenterRegistrationForm.tsx"]);
    expect(read("lib/storage.ts")).toContain('const BUCKET = "business-licenses"');
  });
  it("MIME 제한: avatars/alimtalk-images는 image/*, business-licenses는 image/* + application/pdf(앱 accept와 동일)", () => {
    expect(mime).toContain("allowed_mime_types = array['image/*']");
    expect(mime).toMatch(/where id in \('avatars', 'alimtalk-images'\)/);
    expect(mime).toContain("array['image/*', 'application/pdf']");
    expect(mime).toMatch(/where id = 'business-licenses'/);
    expect(mime).not.toMatch(/video|text\/|octet-stream|\*\/\*/);
  });
  it("업로드하는 버킷은 세 개뿐이다(avatars / alimtalk-images / business-licenses)", () => {
    const buckets = new Set<string>();
    for (const f of execSync(`grep -rlE 'storage\\s*\\.from\\(|BUCKET\\s*=' lib app || true`, { encoding: "utf8" }).split("\n").filter(Boolean)) {
      const src = read(f);
      for (const m of src.matchAll(/storage\s*\.from\(\s*"([a-z-]+)"\s*\)/g)) buckets.add(m[1]);
      for (const m of src.matchAll(/const BUCKET = "([a-z-]+)"/g)) buckets.add(m[1]);
    }
    expect([...buckets].sort()).toEqual(["alimtalk-images", "avatars", "business-licenses"]);
  });
  it("크기 제한은 별도 파일이며 값이 명시돼 있고(10/10/20 MB), 사업자등록증(PDF 스캔)이 사진 버킷보다 작지 않다", () => {
    expect(size).toContain("file_size_limit = 10485760 where id in ('avatars', 'alimtalk-images')");
    expect(size).toContain("file_size_limit = 20971520 where id = 'business-licenses'");
    expect(20971520).toBeGreaterThanOrEqual(10485760);
    expect(size).not.toMatch(/allowed_mime_types/);   // MIME과 크기를 한 파일에 묶지 않는다
    expect(read("fix_storage_bucket_size_limits_20261008.sql")).toContain("사용자 결정 필요");
  });
  it("정책(storage.objects)/공개 여부/객체 데이터는 변경하지 않는다", () => {
    for (const c of [mime, size]) expect(c).not.toMatch(/policy|storage\.objects|\bpublic\s*=|delete|insert|alter /i);
  });
});

describe("DB 권한 migration 정적 계약(B, C)", () => {
  const b = code(read("fix_ensure_center_member_privileges_20261008.sql"));
  const c = code(read("fix_notification_batch_function_privileges_20261008.sql"));
  it("ensure_center_member: PUBLIC/anon/authenticated 회수 + service_role만 허용, 로직 변경 없음", () => {
    expect(b).toContain("revoke all on function public.ensure_center_member(uuid, uuid) from public, anon, authenticated;");
    expect(b).toContain("grant execute on function public.ensure_center_member(uuid, uuid) to service_role;");
    expect(b).not.toMatch(/create (or replace )?function|alter function/i);
  });
  it("알림 배치 함수 3개: 동일 패턴, 로직 변경 없음", () => {
    for (const fn of ["evaluate_notification_rules", "notify_expiring_passes", "notify_upcoming_reservations"]) {
      expect(c).toContain(`revoke all on function public.${fn}() from public, anon, authenticated;`);
      expect(c).toContain(`grant execute on function public.${fn}() to service_role;`);
    }
    expect(c).not.toMatch(/create (or replace )?function|alter function/i);
  });
  it("앱/테스트/Edge Function이 이 네 함수를 rpc로 호출하지 않는다(회수해도 클라이언트 경로 영향 없음)", () => {
    const hits = execSync(`grep -rnE "rpc\\(\\s*[\\"'](ensure_center_member|evaluate_notification_rules|notify_expiring_passes|notify_upcoming_reservations)" app lib tests supabase --include=*.ts --include=*.tsx --exclude=storageBucketLimits.compat.test.ts || true`, { encoding: "utf8" }).trim();
    expect(hits).toBe("");
  });
});
