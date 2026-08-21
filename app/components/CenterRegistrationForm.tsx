"use client";

/*
  센터 등록 입력 필드(이름/주소/대표번호/사업자등록번호/사업자등록증) — 완전히 controlled인
  순수 UI 컴포넌트. 저장/검증 로직은 lib/centers.ts에 있고, 이 컴포넌트는 그 입력값만 담당한다.
  회원가입("센터 운영자") 흐름과 마이페이지 "내 센터 등록하기" 흐름이 이 하나만 공유한다.
*/

import UiIcon from "./UiIcon";

export type CenterFieldsValue = {
  name: string;
  address: string;
  phone: string;
  businessNumber: string;
  licenseFileName: string;
};

type Props = {
  value: CenterFieldsValue;
  onChange: (patch: Partial<CenterFieldsValue>) => void;
  onFileSelect: (file: File | null) => void;
  disabled?: boolean;
};

export default function CenterRegistrationForm({ value, onChange, onFileSelect, disabled }: Props) {
  return (
    <div className="center-fields">
      <div className="center-fields-label">센터 정보</div>
      <input
        className="input-field"
        placeholder="센터 이름"
        value={value.name}
        disabled={disabled}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <input
        className="input-field"
        placeholder="센터 주소"
        value={value.address}
        disabled={disabled}
        onChange={(e) => onChange({ address: e.target.value })}
      />
      <input
        className="input-field"
        placeholder="센터 대표번호"
        value={value.phone}
        disabled={disabled}
        onChange={(e) => onChange({ phone: e.target.value })}
      />
      <input
        className="input-field"
        placeholder="사업자등록번호"
        value={value.businessNumber}
        disabled={disabled}
        onChange={(e) => onChange({ businessNumber: e.target.value })}
      />
      <label className="file-field">
        <span className="file-label">
          {value.licenseFileName ? <><UiIcon name="paperclip" size={14} /> {value.licenseFileName}</> : "사업자등록증 첨부"}
        </span>
        <input
          type="file"
          accept="image/*,.pdf"
          style={{ display: "none" }}
          disabled={disabled}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            onChange({ licenseFileName: f?.name ?? "" });
            onFileSelect(f);
          }}
        />
      </label>
      <div className="center-fields-note">※ 센터 정보는 모두 필수입니다. 등급 체계는 추후 안내 예정</div>
    </div>
  );
}
