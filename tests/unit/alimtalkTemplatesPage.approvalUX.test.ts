/*
  app/manager/alimtalk/templates/page.tsx — 승인 상태별 편집 UX 재정리(2026-10-01, A-9~A-13).
  APR(승인완료)은 읽기 전용 상세 + 복제만, REQ(심사중)는 잠금, REG/REJ는 재구성된 편집
  화면. 불러오기 시트에는 검색(A-12)과 내용 미리보기(A-13)를 추가했다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/manager/alimtalk/templates/page.tsx"), "utf-8");

describe("A-9 — APR(승인됨)은 읽기 전용 상세, REQ(심사중)는 잠금", () => {
  it("승인된 템플릿은 시트 제목이 '템플릿 상세'다", () => {
    expect(source).toContain('isApprovedDetail ? "템플릿 상세" : "템플릿 수정"');
  });

  it("isApprovedDetail은 로컬 status === \"approved\" 기준이다(카카오 APR과 1:1 대응, inspStatusToLocalStatus 매핑)", () => {
    expect(source).toContain('const isApprovedDetail = editing !== "new" && editing?.status === "approved";');
  });

  it("승인된 템플릿은 textarea 대신 읽기 전용 블록으로 문구를 보여준다(편집 불가)", () => {
    expect(source).toContain("isApprovedDetail ? (");
    expect(source).toContain('<div className="alimtalk-readonly-content"');
  });

  it("REQ(로컬 status === \"pending\")도 잠긴다(isLocked)", () => {
    expect(source).toContain('const isLocked = editing !== "new" && (editing?.status === "approved" || editing?.status === "pending");');
  });

  it("잠긴 상태에서는 이름/문구 input이 disabled를 받는다", () => {
    const titleInput = source.slice(source.indexOf('aria-label="템플릿 이름 (내부 관리용)"'), source.indexOf('aria-label="템플릿 이름 (내부 관리용)"') + 250);
    expect(titleInput).toContain("disabled={saving || !canEditThis || isLocked}");
  });

  it("잠긴 상태(APR/REQ)에서는 저장 버튼이 아예 없다 — 대신 닫기만 보인다", () => {
    const actions = source.slice(source.indexOf('<div className="add-profile-actions">', source.indexOf("{editing && (")), source.length);
    expect(actions).toContain("{!isLocked && canEditThis && (");
    expect(actions).toContain('{isLocked ? "닫기" : "취소"}');
  });
});

describe("A-10 — 승인 템플릿의 '새 템플릿으로 복제'", () => {
  const fn = source.slice(source.indexOf("function cloneAsNew"), source.indexOf("function cloneAsNew") + 700);

  it("aligo_template_code는 복사하지 않고(빈 문자열) status는 draft로 초기화한다", () => {
    expect(fn).toContain('setAligoCode("");');
    expect(fn).toContain('setStatus("draft");');
  });

  it("내용(content)은 그대로 복사해서 수정 가능한 새 템플릿으로 연다", () => {
    expect(fn).toContain("setContent(t.content);");
    expect(fn).toContain('setEditing("new");');
  });

  it("복제 버튼을 누른 시점에는 DB insert가 일어나지 않는다 — createAlimtalkTemplate을 호출하지 않고 editing state만 바꾼다(저장 버튼을 눌러야 실제 생성)", () => {
    expect(fn).not.toContain("createAlimtalkTemplate");
    expect(fn).not.toContain("await ");
  });

  it("복제 버튼은 승인된 템플릿 상세에서만 보인다", () => {
    expect(source).toContain("{isApprovedDetail && canEditThis && (");
    expect(source).toContain("새 템플릿으로 복제");
  });
});

describe("A-10 — '삭제'는 로컬 행만 지운다 — 원격 승인 템플릿을 지우는 새 기능을 만들지 않음", () => {
  it("deleteAlimtalkTemplate만 호출한다(알리고 API 삭제 호출 없음)", () => {
    const fn = source.slice(source.indexOf("async function handleDelete"), source.indexOf("async function handleDelete") + 900);
    expect(fn).toContain("await deleteAlimtalkTemplate(t.id);");
    expect(fn).not.toMatch(/functions\.invoke.*delete/i);
  });

  it("승인 템플릿에 한해 버튼 문구가 '센터에서 제거'로, 나머지는 '삭제'로 표시된다(실제 동작은 둘 다 로컬 삭제로 동일)", () => {
    expect(source).toContain('{editing.status === "approved" ? "센터에서 제거" : "삭제"}');
  });
});

describe("A-11 — REG/REJ 편집 화면이 [템플릿 내용]/[카카오 승인] 두 섹션으로 재구성됐다", () => {
  it("섹션 라벨이 '템플릿 내용'과 '카카오 승인'으로 분리돼 있다", () => {
    expect(source).toContain(">템플릿 내용</div>");
    expect(source).toContain(">카카오 승인</div>");
  });

  it("알리고 코드/내부 상태는 더 이상 일반 input/select로 직접 편집할 수 없다 — 읽기 전용 텍스트로만 보여준다", () => {
    expect(source).not.toContain('aria-label="알리고 템플릿 코드 (카카오 승인 후 입력)"');
    expect(source).not.toMatch(/<select className="input-field" value=\{status\}/);
    expect(source).toContain("현재 상태: <strong>{STATUS_LABEL[editing.status]}</strong>");
  });

  it("카카오 승인 신청 버튼은 [카카오 승인] 섹션 안에 있다", () => {
    const section = source.slice(source.indexOf(">카카오 승인</div>"), source.indexOf(">카카오 승인</div>") + 900);
    expect(section).toContain("카카오 승인 신청하기");
  });
});

describe("REQ 상태 동기화 — 편집 시트 내부 중복 불러오기 제거의 보완책(사용자 요청 범위 밖이지만 기능 공백 방지)", () => {
  it("handleRefreshStatus는 새 Edge Function 액션을 추가하지 않고 기존 fetchAligoRemoteTemplates를 재사용한다", () => {
    const fn = source.slice(source.indexOf("async function handleRefreshStatus"), source.indexOf("async function handleRefreshStatus") + 900);
    expect(fn).toContain("await fetchAligoRemoteTemplates(centerId)");
    expect(fn).toContain("inspStatusToLocalStatus(match.inspStatus)");
  });

  it("'상태 새로고침' 버튼은 심사 중(pending)이고 코드가 있는 템플릿에서만 보인다", () => {
    expect(source).toContain('{editing.status === "pending" && editing.aligoTemplateCode && (');
    expect(source).toContain("상태 새로고침");
  });
});

describe("A-12 — 알리고 불러오기 검색(클라이언트 필터, 새 API 호출 없음)", () => {
  it("검색은 importList를 그대로 필터링한다(추가 fetchAligoRemoteTemplates 호출 없음)", () => {
    const fn = source.slice(source.indexOf("const q = importSearch.trim()"), source.indexOf("const q = importSearch.trim()") + 400);
    expect(fn).toContain("(importList ?? []).filter(");
    expect(fn).not.toContain("fetchAligoRemoteTemplates");
  });

  it("templtName/templtCode/templtContent 세 필드를 모두 검색 대상으로 한다", () => {
    const fn = source.slice(source.indexOf("const q = importSearch.trim()"), source.indexOf("const q = importSearch.trim()") + 400);
    expect(fn).toContain("t.templtName.toLowerCase().includes(q)");
    expect(fn).toContain("t.templtCode.toLowerCase().includes(q)");
    expect(fn).toContain("t.templtContent.toLowerCase().includes(q)");
  });

  it("검색 결과 없음 한글 안내가 있다", () => {
    expect(source).toContain("검색 결과가 없어요.");
  });

  it("검색창 placeholder가 요청된 문구와 일치한다", () => {
    expect(source).toContain('placeholder="템플릿 이름·코드·내용 검색"');
  });
});

describe("A-13 — 원격 템플릿 상세 내용 미리보기(펼치기/접기)", () => {
  it("기본은 line-clamp로 2줄만 보이고, 누르면 펼쳐진다(expandedCode 토글)", () => {
    expect(source).toContain("setExpandedCode(expanded ? null : t.templtCode)");
    expect(source).toContain('className={`alimtalk-import-preview ${expanded ? "expanded" : ""}`}');
  });

  it("가져오기 전에 실제 문구(t.templtContent)를 보여준다", () => {
    const item = source.slice(source.indexOf("alimtalk-import-preview-toggle"), source.indexOf("alimtalk-import-preview-toggle") + 500);
    expect(item).toContain("{t.templtContent}");
  });
});

describe("A-14 — 원격 상태 한글 라벨 유지, OTP 시스템 템플릿 계속 제외", () => {
  it("ALIGO_INSP_STATUS_KO(APR/REQ/REG/REJ → 승인/심사 중/등록/반려)를 그대로 쓴다", () => {
    expect(source).toContain("ALIGO_INSP_STATUS_KO[t.inspStatus]");
  });

  it("두 불러오기 경로(메인 목록 + 검색 필터 대상) 모두 excludeSystemAligoTemplates를 거친 뒤의 importList를 쓴다", () => {
    expect(source).toContain("excludeSystemAligoTemplates(await fetchAligoRemoteTemplates(centerId))");
  });
});

describe("UI 스타일 — 새 색상/새 컴포넌트 프레임워크 도입 없음(A-8 포함)", () => {
  it("리스트 카드는 기존 hist-item/hist-title/hist-sub/hist-status 클래스를 그대로 재사용한다", () => {
    const listBlock = source.slice(source.indexOf("templates.map((t) =>"), source.indexOf("templates.map((t) =>") + 900);
    expect(listBlock).toContain("hist-item");
    expect(listBlock).toContain("hist-title");
    expect(listBlock).toContain("hist-sub");
    expect(listBlock).toContain("hist-status");
  });

  it("새 하드코딩 색상(#RRGGBB)을 JSX에 추가하지 않았다", () => {
    const jsx = source.slice(source.indexOf("return (\n    <div className=\"app-shell\">"));
    expect(jsx).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
