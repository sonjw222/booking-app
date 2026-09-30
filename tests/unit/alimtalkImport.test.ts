/*
  실기기 QA(2026-09-30) — "알리고 템플릿 불러오기" 공용 로직(lib/alimtalk.ts).
  새 Aligo API 기능이 아니라 기존 fetchAligoRemoteTemplates/createAlimtalkTemplate을 그대로
  재사용하는 매핑/필터 헬퍼들을 검증한다.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const insertMock = vi.fn();
const selectMock = vi.fn();
const singleMock = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: () => ({ insert: (...args: unknown[]) => insertMock(...args) }),
  },
}));

import {
  ALIGO_INSP_STATUS_KO,
  OTP_SYSTEM_ALIGO_TEMPLATE_CODE,
  excludeSystemAligoTemplates,
  extractTemplateVariables,
  importAligoTemplateAsLocal,
  inspStatusToLocalStatus,
  isAligoTemplateAlreadyImported,
  type AligoRemoteTemplate,
  type AlimtalkTemplate,
} from "../../lib/alimtalk";

beforeEach(() => {
  insertMock.mockReset();
  selectMock.mockReset();
  singleMock.mockReset();
  insertMock.mockReturnValue({ select: selectMock });
  selectMock.mockReturnValue({ single: singleMock });
});

const remote = (over: Partial<AligoRemoteTemplate> = {}): AligoRemoteTemplate => ({
  templtCode: "TPL001", templtName: "출석 안내", templtContent: "[[회원명]]님, 오늘 수업이에요.", inspStatus: "APR",
  ...over,
});

describe("extractTemplateVariables", () => {
  it("[[변수]] 형태를 전부 뽑고 중복은 제거한다", () => {
    expect(extractTemplateVariables("[[회원명]]님, [[수강권명]] 잔여 [[수강권명]]")).toEqual(["회원명", "수강권명"]);
  });
  it("변수가 없으면 빈 배열", () => {
    expect(extractTemplateVariables("안내 문구입니다")).toEqual([]);
  });
});

describe("OTP 시스템 템플릿 제외", () => {
  it("UL_8353(회원가입 OTP 전용)은 불러오기 목록에서 제외된다", () => {
    const list = [remote({ templtCode: OTP_SYSTEM_ALIGO_TEMPLATE_CODE, templtName: "인증번호 안내" }), remote({ templtCode: "TPL002" })];
    const filtered = excludeSystemAligoTemplates(list);
    expect(filtered.map((t) => t.templtCode)).toEqual(["TPL002"]);
  });
  it("OTP 코드가 없으면 목록이 그대로 유지된다", () => {
    const list = [remote({ templtCode: "TPL002" }), remote({ templtCode: "TPL003" })];
    expect(excludeSystemAligoTemplates(list)).toHaveLength(2);
  });
});

describe("상태 라벨 — APR/REQ/REG/REJ 한글 매핑", () => {
  it("정확히 요구된 4단어로 매핑된다", () => {
    expect(ALIGO_INSP_STATUS_KO.APR).toBe("승인");
    expect(ALIGO_INSP_STATUS_KO.REQ).toBe("심사 중");
    expect(ALIGO_INSP_STATUS_KO.REG).toBe("등록");
    expect(ALIGO_INSP_STATUS_KO.REJ).toBe("반려");
  });
});

describe("isAligoTemplateAlreadyImported", () => {
  const local = (code: string | null): AlimtalkTemplate => ({
    id: "x", centerId: "c1", aligoTemplateCode: code, title: "t", content: "c", variables: [], status: "draft", isActive: true,
  });
  it("이미 같은 aligo_template_code로 등록된 로컬 템플릿이 있으면 true", () => {
    expect(isAligoTemplateAlreadyImported([local("TPL001")], "TPL001")).toBe(true);
  });
  it("없으면 false", () => {
    expect(isAligoTemplateAlreadyImported([local("TPL002")], "TPL001")).toBe(false);
    expect(isAligoTemplateAlreadyImported([local(null)], "TPL001")).toBe(false);
    expect(isAligoTemplateAlreadyImported([], "TPL001")).toBe(false);
  });
});

describe("importAligoTemplateAsLocal — 필드 매핑 + 기존 helper 재사용", () => {
  it("title/content/aligo_template_code/status/center_id를 정확히 매핑해 insert한다", async () => {
    singleMock.mockResolvedValue({ data: { id: "new-id" }, error: null });
    const id = await importAligoTemplateAsLocal("center-123", remote({ inspStatus: "REQ" }));
    expect(id).toBe("new-id");
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      center_id: "center-123",
      title: "출석 안내",
      content: "[[회원명]]님, 오늘 수업이에요.",
      variables: ["회원명"],
      aligo_template_code: "TPL001",
      status: "pending", // inspStatusToLocalStatus("REQ")
    }));
  });

  it("승인(APR)/반려(REJ)/등록(REG) 상태도 기존 inspStatusToLocalStatus 매핑을 그대로 따른다", async () => {
    singleMock.mockResolvedValue({ data: { id: "x" }, error: null });
    await importAligoTemplateAsLocal("c1", remote({ inspStatus: "APR" }));
    expect(insertMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: "approved" }));
    await importAligoTemplateAsLocal("c1", remote({ inspStatus: "REJ" }));
    expect(insertMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: "rejected" }));
    await importAligoTemplateAsLocal("c1", remote({ inspStatus: "REG" }));
    expect(insertMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: "draft" }));
    expect(inspStatusToLocalStatus("REG")).toBe("draft");
  });

  it("DB insert 실패는 그대로 throw된다(호출 쪽이 toUserMessage로 안전하게 감쌈)", async () => {
    singleMock.mockResolvedValue({ data: null, error: { message: "new row violates row-level security policy" } });
    await expect(importAligoTemplateAsLocal("c1", remote())).rejects.toThrow("템플릿 등록에 실패했어요");
  });
});
