import type { InquiryDraft } from "../app/components/InquiryChat";
export const INQUIRY_DRAFT_PREFIX = "mwhabit-inquiry-drafts:";
export function readInquiryDrafts(accountId: string, now = Date.now()): Record<string, InquiryDraft> {
  try {
    const value = JSON.parse(sessionStorage.getItem(INQUIRY_DRAFT_PREFIX + accountId) ?? "null");
    if (!value || typeof value.savedAt !== "number" || now - value.savedAt > 86400000 || !value.drafts || typeof value.drafts !== "object") return {};
    const valid = Object.entries(value.drafts).filter((entry): entry is [string, InquiryDraft] => {
      const [id, draft] = entry;
      return id.length < 100 && !!draft && typeof draft === "object" && typeof (draft as InquiryDraft).text === "string" && Array.isArray((draft as InquiryDraft).photos) && (draft as InquiryDraft).photos.every((p) => typeof p === "string");
    });
    return Object.fromEntries(valid);
  } catch { return {}; }
}
export function writeInquiryDrafts(accountId: string, drafts: Record<string, InquiryDraft>) {
  try {
    const nonempty = Object.fromEntries(Object.entries(drafts).filter(([, draft]) => draft.text.trim() || draft.photos.length));
    sessionStorage.setItem(INQUIRY_DRAFT_PREFIX + accountId, JSON.stringify({ savedAt: Date.now(), drafts: nonempty }));
    return true;
  } catch { return false; }
}
export function clearInquiryDrafts() {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(INQUIRY_DRAFT_PREFIX)) sessionStorage.removeItem(key); } catch { /* unavailable storage */ }
}
