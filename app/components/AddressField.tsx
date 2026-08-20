"use client";

/*
  도로명주소 입력 (선택) — 다음 우편번호 서비스 팝업으로 도로명주소를 검색해 채우고,
  상세주소(동/호수 등)는 별도 텍스트로 입력받는다. 회원가입 폼(app/login/page.tsx)과
  소셜 가입 직후 휴대폰 번호 입력 모달(app/components/SessionWatcher.tsx)이 공용으로 쓴다.
  base/detail을 합친 하나의 문자열을 accounts.address(text) 한 컬럼에 저장하는 게 목적이라,
  두 값을 부모가 합쳐 쓰기 쉽도록 별도 상태로 분리해 넘긴다.
*/

import { useState } from "react";
import { openDaumPostcode } from "../../lib/daumPostcode";

type Props = {
  base: string;
  detail: string;
  onChangeBase: (v: string) => void;
  onChangeDetail: (v: string) => void;
  disabled?: boolean;
};

export default function AddressField({ base, detail, onChangeBase, onChangeDetail, disabled }: Props) {
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSearch() {
    setError(null);
    setSearching(true);
    openDaumPostcode(
      (result) => {
        onChangeBase(result.roadAddress);
        setSearching(false);
      },
      () => setSearching(false)
    ).catch((e: any) => {
      setError(e.message ?? "주소 검색에 실패했어요");
      setSearching(false);
    });
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="input-field"
          style={{ flex: 1 }}
          placeholder="도로명주소 (선택)"
          value={base}
          readOnly
          onClick={handleSearch}
          disabled={disabled}
        />
        <button
          type="button"
          className="text-btn"
          style={{ flexShrink: 0, fontWeight: 800, fontSize: 14, padding: "0 4px" }}
          onClick={handleSearch}
          disabled={disabled || searching}
        >
          {searching ? "검색 중" : "주소 검색"}
        </button>
      </div>
      {base && (
        <input
          className="input-field"
          style={{ marginTop: 8 }}
          placeholder="상세주소 (동/호수 등, 선택)"
          value={detail}
          onChange={(e) => onChangeDetail(e.target.value)}
          disabled={disabled}
        />
      )}
      {error && <div className="auth-msg error">{error}</div>}
    </div>
  );
}
