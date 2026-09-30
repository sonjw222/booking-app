/*
  app/manager/alimtalk/templates/page.tsx — "알리고 템플릿 불러오기" UX 정적 검토(2026-09-30).
  이 프로젝트 관례대로(예: tests/unit/loginPage.socialLoadingReset.test.ts) 소스 텍스트를
  검토해 요구사항이 실제로 반영됐는지, 기존 생성/수정/삭제/승인 흐름이 회귀 없이 유지되는지
  확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/manager/alimtalk/templates/page.tsx"), "utf-8");

describe("1-A. 메인 화면 진입점 — 빈 상태/일반 상태 모두 접근 가능", () => {
  it("상단 헤더에 기존 '+ 템플릿'과 별개로 '알리고 불러오기' 버튼이 있다(새 템플릿 생성과 구분)", () => {
    expect(source).toContain("onClick={openImportSheet}");
    expect(source).toContain("+ 템플릿");
    expect(source).toContain("알리고 불러오기");
  });

  it("템플릿 0개 빈 상태에도 '알리고 템플릿 불러오기'와 '첫 템플릿 만들기'가 함께 보인다", () => {
    const emptyBlock = source.slice(source.indexOf("등록된 템플릿이 없어요"), source.indexOf("등록된 템플릿이 없어요") + 400);
    expect(emptyBlock).toContain("openImportSheet");
    expect(emptyBlock).toContain("openNew");
    expect(emptyBlock).toContain("첫 템플릿 만들기");
  });

  it("헤더의 '알리고 불러오기'는 templates.length와 무관하게 항상 렌더된다(조건부 렌더링으로 숨겨지지 않음)", () => {
    const headerBlock = source.slice(source.indexOf('<div className="back-header">'), source.indexOf("center-switcher"));
    // templates.length 조건이 이 버튼을 감싸지 않는다 — 헤더 블록 안에 조건부 {templates...} 가드가 없어야 함
    expect(headerBlock).not.toMatch(/templates\.length[^}]*openImportSheet/);
  });
});

describe("1-B. 원격 목록 조회 + 상태 한글 표시", () => {
  it("fetchAligoRemoteTemplates(centerId)를 그대로 재사용한다(새 API 없음)", () => {
    expect(source).toContain("await fetchAligoRemoteTemplates(centerId)");
  });

  it("목록에 템플릿 이름/코드/상태가 보이고, 코드는 보조 정보로만 표시한다(강조 없음)", () => {
    const sheetBlock = source.slice(source.indexOf("알리고 템플릿 불러오기"), source.indexOf("{toast &&"));
    expect(sheetBlock).toContain("t.templtName");
    expect(sheetBlock).toContain("hist-sub");
    expect(sheetBlock).toContain("t.templtCode");
    expect(sheetBlock).toContain("ALIGO_INSP_STATUS_KO[t.inspStatus]");
  });
});

describe("1-C/1-D. 가져오기 + 매핑 + 중복 방지", () => {
  it("가져오기는 importAligoTemplateAsLocal(기존 createAlimtalkTemplate 재사용)을 호출한다", () => {
    const fn = source.slice(source.indexOf("async function handleImport"), source.indexOf("function handlePickRemote"));
    expect(fn).toContain("importAligoTemplateAsLocal(centerId, remote)");
  });

  it("가져오기 전에 클라이언트 로컬 템플릿 목록 기준으로 중복을 먼저 확인한다", () => {
    const fn = source.slice(source.indexOf("async function handleImport"), source.indexOf("function handlePickRemote"));
    expect(fn).toContain("isAligoTemplateAlreadyImported(templates, remote.templtCode)");
    expect(fn).toContain("이미 등록된 템플릿이에요");
  });

  it("이미 가져온 템플릿은 목록에서 '가져오기' 버튼 대신 안내만 보인다(2차 방어)", () => {
    const sheetBlock = source.slice(source.indexOf("알리고 템플릿 불러오기"), source.indexOf("{toast &&"));
    expect(sheetBlock).toContain("이미 등록됨");
  });

  it("가져오기 중 중복 클릭을 막는다(진행 중인 코드 하나만 허용)", () => {
    const fn = source.slice(source.indexOf("async function handleImport"), source.indexOf("function handlePickRemote"));
    expect(fn).toMatch(/if \(!centerId \|\| importingCode\) return;/);
  });
});

describe("1-E. OTP 시스템 템플릿 제외 — 실제 OTP 발송 구조는 그대로", () => {
  it("불러오기 목록 조회 시 excludeSystemAligoTemplates로 필터링한다", () => {
    expect(source).toContain("excludeSystemAligoTemplates(await fetchAligoRemoteTemplates(centerId))");
    // 새 시트(loadImportList)와 기존 편집 시트(handleLoadFromAligo) 둘 다 필터링돼야 한다.
    const occurrences = source.match(/excludeSystemAligoTemplates\(await fetchAligoRemoteTemplates\(centerId\)\)/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("send-phone-otp/ALIGO_OTP_TEMPLATE_CODE 등 실제 OTP 발송 코드는 이 파일에서 건드리지 않는다", () => {
    expect(source).not.toMatch(/send-phone-otp|ALIGO_OTP_TEMPLATE_CODE/);
  });
});

describe("1-F. 기존 생성/수정/삭제/승인 흐름 회귀 없음", () => {
  it("새 템플릿 생성(createAlimtalkTemplate)과 수정(updateAlimtalkTemplate)을 그대로 호출한다", () => {
    expect(source).toContain('await createAlimtalkTemplate(isCommon ? null : centerId, { title: title.trim(), content: content.trim(), variables });');
    expect(source).toContain("await updateAlimtalkTemplate(editing.id,");
  });

  it("삭제(deleteAlimtalkTemplate)와 카카오 승인 신청(createAligoRemoteTemplate/submitAligoTemplateForApproval)을 그대로 호출한다", () => {
    expect(source).toContain("await deleteAlimtalkTemplate(t.id);");
    expect(source).toContain("await createAligoRemoteTemplate(centerParam, editing.title, editing.content);");
    expect(source).toContain("await submitAligoTemplateForApproval(centerParam, created.templtCode);");
  });

  it("기존 편집 시트 안의 '알리고에서 불러오기'(코드/상태만 채우는 용도)는 그대로 남아 있다", () => {
    expect(source).toContain("알리고에서 불러오기");
    expect(source).toContain("function handlePickRemote(templtCode: string)");
  });
});

describe("5. 사용자 오류 한글화 — raw error 노출 금지", () => {
  it("모든 catch 블록이 e.message를 직접 노출하지 않고 toUserMessage를 거친다", () => {
    const rawExposures = source.match(/\bsetError\(e\.message\)|\bshowToast\(e\.message\)/g) ?? [];
    expect(rawExposures).toHaveLength(0);
  });

  it("toUserMessage를 import해서 쓴다", () => {
    expect(source).toContain('import { toUserMessage } from "../../../../lib/userError";');
    expect((source.match(/toUserMessage\(/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

describe("4. UI 스타일 — 기존 공용 컴포넌트/클래스 재사용", () => {
  it("새 모달은 기존 SheetOverlay를 재사용한다(새 모달 프레임워크 없음)", () => {
    const sheetBlock = source.slice(source.indexOf("{importOpen && ("), source.indexOf("{toast &&"));
    expect(sheetBlock).toContain("<SheetOverlay");
  });

  it("새로운 강조색을 추가하지 않는다(기존 outline-action/hist-item/perm-guide 클래스 재사용)", () => {
    const sheetBlock = source.slice(source.indexOf("{importOpen && ("), source.indexOf("{toast &&"));
    expect(sheetBlock).toContain("outline-action");
    expect(sheetBlock).toContain("hist-item");
    expect(sheetBlock).not.toMatch(/#[0-9a-fA-F]{3,6}/); // 하드코딩된 새 색상 없음
  });
});
