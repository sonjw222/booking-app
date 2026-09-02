"use client";

/*
  알림톡/문자 발송 공용 컴포저 — 텍스트/사진 블록을 순서대로 쌓아 "텍스트→사진→텍스트" 구성을
  지원한다(app/manager/members/page.tsx 회원탭 발송 시트, app/manager/alimtalk/send 공용).

  카카오 알림톡은 사전 승인된 템플릿만 발송 가능해서 자유 이미지 삽입이 안 된다(카카오 정책) —
  이 컴포넌트는 UI/데이터 구조만 먼저 만들기로 한 결정(사용자, 2026-09-01)에 따른 것이고,
  즉시 발송 시 이미지 블록은 flattenAlimtalkBlocks()가 텍스트로 치환해서 보낸다(실제 카톡에는
  아직 안 실릴 수 있음 — 안내 문구 참고).
*/

import { useRef, useState, type ChangeEvent } from "react";
import UiIcon from "./UiIcon";
import { uploadAlimtalkImage } from "../../lib/alimtalkImages";

export type AlimtalkBlock = { type: "text"; value: string } | { type: "image"; url: string };

export function emptyAlimtalkBlocks(): AlimtalkBlock[] {
  return [{ type: "text", value: "" }];
}

// 즉시 발송용 평문 직렬화 — 이미지 블록은 실제 알림톡에 못 실으니 SMS 대체발송 시나마
// 텍스트로 전달되게 URL을 남긴다.
export function flattenAlimtalkBlocks(blocks: AlimtalkBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.value : `[사진: ${b.url}]`))
    .join("\n")
    .trim();
}

export function hasAlimtalkContent(blocks: AlimtalkBlock[]): boolean {
  return blocks.some((b) => (b.type === "text" ? b.value.trim().length > 0 : true));
}

export default function AlimtalkComposer({
  blocks,
  onChange,
  disabled,
}: {
  blocks: AlimtalkBlock[];
  onChange: (blocks: AlimtalkBlock[]) => void;
  disabled?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  function updateText(index: number, value: string) {
    const next = blocks.slice();
    next[index] = { type: "text", value };
    onChange(next);
  }

  function removeImage(index: number) {
    const next = blocks.slice();
    next.splice(index, 1);
    onChange(next);
  }

  async function handlePickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadAlimtalkImage(file);
      // 사진 뒤에 새 텍스트 블록을 자동으로 붙여서 계속 이어 쓸 수 있게 함(텍스트→사진→텍스트)
      onChange([...blocks, { type: "image", url }, { type: "text", value: "" }]);
    } catch (err: any) {
      alert(err.message ?? "사진 업로드에 실패했어요");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="alimtalk-composer">
      {blocks.map((b, i) =>
        b.type === "text" ? (
          <textarea
            key={i}
            className="input-field"
            style={{ minHeight: 90, resize: "vertical", paddingTop: 12, marginBottom: 8 }}
            placeholder={i === 0 ? "보낼 내용을 입력하세요" : "이어서 보낼 내용을 입력하세요"}
            value={b.value}
            onChange={(e) => updateText(i, e.target.value)}
            disabled={disabled}
          />
        ) : (
          <div key={i} style={{ position: "relative", marginBottom: 8 }}>
            <img src={b.url} alt="첨부 사진" style={{ maxWidth: "100%", borderRadius: 8, display: "block" }} />
            {!disabled && (
              <button
                type="button"
                onClick={() => removeImage(i)}
                style={{
                  position: "absolute", top: 6, right: 6, width: 26, height: 26, border: "none",
                  borderRadius: "50%", background: "rgba(0,0,0,.55)", color: "var(--text-inverse)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <UiIcon name="close" size={14} />
              </button>
            )}
          </div>
        )
      )}
      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handlePickImage} />
      <button
        type="button"
        className="outline-action compact"
        disabled={disabled || uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        <UiIcon name="paperclip" size={15} /> {uploading ? "업로드 중..." : "사진 추가"}
      </button>
      <div className="perm-guide" style={{ marginTop: 8 }}>
        카카오 알림톡은 사전 승인된 템플릿만 발송 가능해 사진이 실제 카톡에는 아직 안 실릴 수 있어요
        (SMS 대체발송 시 텍스트로만 전달돼요).
      </div>
    </div>
  );
}
