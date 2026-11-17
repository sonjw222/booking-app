import type { NicepayV3Params } from "./nicepayV3Window";

// Separate from real-order validation: a review response cannot be submitted to the approval ReturnURL.
export function validateReviewWindowParams(raw: unknown, origin: string): NicepayV3Params | null {
  if (!raw || typeof raw !== "object" || origin !== "https://mwhabit.com") return null;
  const p = raw as Record<string, unknown>;
  if (p.MID !== "nicepay00m" || p.PayMethod !== "CARD" || p.CharSet !== "utf-8") return null;
  if (typeof p.Moid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.Moid)) return null;
  if (typeof p.Amt !== "string" || !/^[1-9][0-9]*$/.test(p.Amt) || !Number.isSafeInteger(Number(p.Amt))) return null;
  if (typeof p.GoodsName !== "string" || !p.GoodsName.trim() || Array.from(p.GoodsName).length > 20) return null;
  if (typeof p.EdiDate !== "string" || !/^\d{14}$/.test(p.EdiDate) || typeof p.SignData !== "string" || !/^[a-f0-9]{64}$/i.test(p.SignData)) return null;
  if (typeof p.ReturnURL !== "string") return null;
  try {
    const u = new URL(p.ReturnURL);
    if (u.origin !== origin || u.username || u.password || u.hash || u.pathname !== "/api/payments/nicepay/review-window/return" || !u.searchParams.get("rt") || [...u.searchParams.keys()].some(k => k !== "rt") || u.searchParams.getAll("rt").length !== 1) return null;
  } catch { return null; }
  return { MID: p.MID, Moid: p.Moid, Amt: p.Amt, GoodsName: p.GoodsName, EdiDate: p.EdiDate, SignData: p.SignData, ReturnURL: p.ReturnURL, PayMethod: "CARD", CharSet: "utf-8" };
}
