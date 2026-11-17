import { AUTH_RESPONSE_FIELDS, REGISTRATION_FIELDS, type RegistrationParams } from "./nicepaySubscriptionReviewProtocol";
import { NICEPAY_V3_SDK_URL } from "./nicepayV3Window";

export type RegistrationWindow = Window & { goPay?: (form: HTMLFormElement) => void; nicepaySubmit?: () => void; nicepayClose?: () => void };
export async function loadRegistrationSdk(doc: Document, win: RegistrationWindow): Promise<void> {
  if (typeof win.goPay === "function") return;
  await new Promise<void>((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = NICEPAY_V3_SDK_URL; script.async = true; script.charset = "euc-kr";
    const timer = win.setTimeout(() => finish(false), 15000);
    function finish(ok: boolean) {
      win.clearTimeout(timer); script.onload = null; script.onerror = null;
      if (ok && typeof win.goPay === "function") resolve();
      else { script.remove(); reject(new Error("심사용 확인창을 불러오지 못했어요")); }
    }
    script.onload = () => finish(true); script.onerror = () => finish(false);
    doc.head.appendChild(script);
  });
}
export function openRegistrationWindow(params: RegistrationParams, doc: Document, win: RegistrationWindow, closed: () => void): () => void {
  if (typeof win.goPay !== "function") throw new Error("심사용 확인창을 불러오지 못했어요");
  const form = doc.createElement("form");
  form.name = "nicepaySubscriptionRegistrationForm"; form.method = "post"; form.action = params.ReturnURL;
  form.acceptCharset = "euc-kr"; form.hidden = true;
  for (const key of REGISTRATION_FIELDS) {
    const input = doc.createElement("input"); input.type = "hidden"; input.name = key; input.value = params[key]; form.appendChild(input);
  }
  doc.body.appendChild(form);
  let disposed = false, submitted = false;
  let timer: number | undefined;
  // PC callback: forward only authentication protocol fields. Never submit SDK card fields.
  const submit = () => {
    if (disposed || submitted) return;
    submitted = true;
    const safeForm = doc.createElement("form");
    safeForm.method = "post"; safeForm.action = params.ReturnURL; safeForm.acceptCharset = "utf-8"; safeForm.hidden = true;
    for (const key of AUTH_RESPONSE_FIELDS) {
      for (const value of new FormData(form).getAll(key)) {
        if (typeof value !== "string") continue;
        const input = doc.createElement("input"); input.type = "hidden"; input.name = key; input.value = value; safeForm.appendChild(input);
      }
    }
    doc.body.appendChild(safeForm);
    try { safeForm.submit(); } finally { safeForm.remove(); dispose(); }
  };
  const close = () => {
    if (disposed || submitted) return;
    win.clearTimeout(timer);
    timer = win.setTimeout(() => { if (!disposed && !submitted) { dispose(); closed(); } }, 1500);
  };
  function dispose() {
    if (disposed) return;
    disposed = true; win.clearTimeout(timer); form.remove();
    if (win.nicepaySubmit === submit) delete win.nicepaySubmit;
    if (win.nicepayClose === close) delete win.nicepayClose;
  }
  win.nicepaySubmit = submit; win.nicepayClose = close;
  try { win.goPay(form); } catch (error) { dispose(); throw error; }
  return dispose;
}
