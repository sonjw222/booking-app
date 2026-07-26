/*
  센터 후기 + 포인트
  - 수강권 구매자만 후기 작성 → 센터 포인트 적립
  - 적립된 포인트는 그 센터 결제 시 사용
*/

import { supabase } from "./supabaseClient";

export type Review = {
  id: string;
  profileId: string;
  writerName: string;
  rating: number;
  content: string;
  photos: string[] | null;
  reply: string | null;
  createdAt: string;
};

const KST_MD = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "2-digit", month: "2-digit", day: "2-digit",
});

async function myProfileId(): Promise<string> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw new Error("로그인이 필요해요");
  const { data: acc } = await supabase.from("accounts").select("id").eq("auth_id", authData.user.id).single();
  if (!acc) throw new Error("계정을 찾을 수 없어요");
  const { data: profs } = await supabase
    .from("profiles").select("id, is_primary, created_at")
    .eq("account_id", acc.id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  const prof = profs?.[0];
  if (!prof) throw new Error("프로필을 찾을 수 없어요");
  return prof.id;
}

// 센터 후기 목록
export async function fetchReviews(centerId: string): Promise<Review[]> {
  const { data, error } = await supabase
    .from("center_reviews")
    .select("id, profile_id, rating, content, photos, reply, created_at, profiles(name, nickname)")
    .eq("center_id", centerId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error("후기를 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => {
    const nm = r.profiles?.nickname || r.profiles?.name || "회원";
    // 이름 가운데 마스킹 (홍길동 → 홍*동)
    const masked = nm.length <= 1 ? nm
      : nm.length === 2 ? nm[0] + "*"
      : nm[0] + "*".repeat(nm.length - 2) + nm[nm.length - 1];
    return {
      id: r.id, profileId: r.profile_id,
      writerName: masked,
      rating: r.rating, content: r.content, photos: r.photos ?? null,
      reply: r.reply ?? null,
      createdAt: KST_MD.format(new Date(r.created_at)),
    };
  });
}

// 내가 이 센터에 후기를 썼는지
export async function myReviewFor(centerId: string): Promise<Review | null> {
  try {
    const profileId = await myProfileId();
    const { data } = await supabase
      .from("center_reviews")
      .select("id, profile_id, rating, content, photos, reply, created_at")
      .eq("center_id", centerId).eq("profile_id", profileId)
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.id, profileId: data.profile_id, writerName: "나",
      rating: data.rating, content: data.content, photos: data.photos ?? null,
      reply: (data as any).reply ?? null,
      createdAt: KST_MD.format(new Date(data.created_at)),
    };
  } catch { return null; }
}

// 후기 작성 (포인트 자동 적립)
export async function writeReview(centerId: string, rating: number, content: string, photos?: string[]): Promise<number> {
  const profileId = await myProfileId();
  const { data, error } = await supabase.rpc("write_review", {
    p_center_id: centerId, p_profile_id: profileId,
    p_rating: rating, p_content: content,
    p_photos: photos && photos.length > 0 ? photos : null,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return (data as any)?.point ?? 0;
}

export async function deleteReview(reviewId: string): Promise<void> {
  const { error } = await supabase.from("center_reviews").delete().eq("id", reviewId);
  if (error) throw new Error("후기 삭제에 실패했어요: " + error.message);
}

// 이 센터에서 내 포인트 잔액
export async function fetchMyPoints(centerId: string): Promise<number> {
  try {
    const profileId = await myProfileId();
    const { data } = await supabase
      .from("point_accounts").select("balance")
      .eq("center_id", centerId).eq("profile_id", profileId)
      .maybeSingle();
    return data?.balance ?? 0;
  } catch { return 0; }
}

// 포인트 사용 (결제 시)
export async function usePoints(centerId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const profileId = await myProfileId();
  const { error } = await supabase.rpc("use_points", {
    p_center_id: centerId, p_profile_id: profileId, p_amount: amount,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

// 내 전체 포인트 (센터별)
export type PointBalance = { centerId: string; centerName: string; balance: number };

export async function fetchAllMyPoints(): Promise<PointBalance[]> {
  const { data, error } = await supabase
    .from("point_accounts")
    .select("center_id, balance, centers(name)")
    .gt("balance", 0)
    .order("balance", { ascending: false });
  if (error) return [];
  return (data ?? []).map((p: any) => ({
    centerId: p.center_id,
    centerName: p.centers?.name ?? "센터",
    balance: p.balance,
  }));
}

// 후기 사진 업로드 (avatars 버킷 재사용)
export async function uploadReviewPhoto(file: File): Promise<string> {
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `reviews/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file, { upsert: true });
  if (error) throw new Error("사진 업로드에 실패했어요: " + error.message);
  return path;
}

export function reviewPhotoUrl(path: string | null): string | null {
  if (!path) return null;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return data.publicUrl;
}

/* ============================================================
   관리자 - 후기 관리
   ============================================================ */

export type ManagerReview = Review & {
  reply: string | null;
  repliedAt: string | null;
};

export type ReviewStats = { total: number; avgRating: number; noReply: number };

export async function fetchCenterReviewsForManager(centerId: string): Promise<ManagerReview[]> {
  const { data, error } = await supabase
    .from("center_reviews")
    .select("id, profile_id, rating, content, photos, reply, replied_at, created_at, profiles(name, nickname)")
    .eq("center_id", centerId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("후기를 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id, profileId: r.profile_id,
    writerName: r.profiles?.nickname || r.profiles?.name || "회원",  // 관리자는 실명 확인
    rating: r.rating, content: r.content, photos: r.photos ?? null,
    createdAt: KST_MD.format(new Date(r.created_at)),
    reply: r.reply ?? null,
    repliedAt: r.replied_at ? KST_MD.format(new Date(r.replied_at)) : null,
  }));
}

export async function fetchReviewStats(centerId: string): Promise<ReviewStats> {
  const { data, error } = await supabase.rpc("center_review_stats", { p_center_id: centerId });
  if (error) return { total: 0, avgRating: 0, noReply: 0 };
  const r = (data ?? [])[0] as any;
  return {
    total: Number(r?.total ?? 0),
    avgRating: Number(r?.avg_rating ?? 0),
    noReply: Number(r?.no_reply ?? 0),
  };
}

export async function replyToReview(reviewId: string, reply: string): Promise<void> {
  const { error } = await supabase.rpc("reply_review", { p_review_id: reviewId, p_reply: reply });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

// 매니저가 악성 후기 삭제
export async function deleteReviewAsManager(reviewId: string): Promise<void> {
  const { error } = await supabase.from("center_reviews").delete().eq("id", reviewId);
  if (error) throw new Error("후기 삭제에 실패했어요: " + error.message);
}
