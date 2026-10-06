/*
  룸 관리 "지도에서 위치 지정" — 도로명 주소 검색 + 상세주소 기능(2026-10-01).
  이 프로젝트 관례대로(렌더링 도구 없이 소스 텍스트 검토, tests/unit/loginPage.* 등 참고)
  요구사항 A~K가 실제로 반영됐는지, 기존 지도 클릭/좌표 저장 기능이 회귀 없이 유지되는지
  확인한다. 네트워크 로직 자체(성공/실패/빈 결과)는 tests/unit/geocoding.test.ts가 별도로
  실제 단위 테스트로 검증한다 — 여기서는 "그 로직을 올바른 곳에 올바르게 연결했는지"만 본다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pickerRaw = readFileSync(join(__dirname, "../../app/manager/center-info/MapPicker.tsx"), "utf-8");
// 파일 상단 설명 주석이 "이전 버전은 limit=1이었다"를 언급해 forbidden-pattern 검사가
// 주석 자체에 오탐하지 않도록, 주석을 제거한 버전을 코드 검사에 쓴다(다른 파일에서도
// 반복된 패턴 — tests/unit/managerSettingsPage.iosZoomFix.test.ts 참고).
const picker = pickerRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const roomsPage = readFileSync(join(__dirname, "../../app/manager/rooms/page.tsx"), "utf-8");
const roomsLib = readFileSync(join(__dirname, "../../lib/rooms.ts"), "utf-8");
const geocodingLib = readFileSync(join(__dirname, "../../lib/geocoding.ts"), "utf-8");
const migration = readFileSync(join(__dirname, "../../add_room_detail_address.sql"), "utf-8");
const cssRaw = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

describe("A/B. 장소명 검색 + 도로명 주소 검색이 같은 입력을 쓴다(기존 기능 유지 + 확장)", () => {
  it("검색창 placeholder가 장소명/도로명 주소를 모두 안내한다", () => {
    expect(picker).toContain('placeholder="장소명 또는 도로명 주소 검색"');
  });

  it("검색은 searchAddress(limit 5)를 호출해 여러 결과를 받는다(첫 결과 자동 선택 아님)", () => {
    expect(picker).toContain("await searchAddress(search, 5)");
    expect(picker).not.toMatch(/limit=1(?!\d)/);
  });

  it("정확한 도로명 주소 찾기(다음 우편번호, 기존 lib/daumPostcode.ts 재사용) 진입점이 있다 — 새 지도 라이브러리/새 API 키 없음", () => {
    expect(picker).toContain('import { openDaumPostcode } from "../../../lib/daumPostcode";');
    expect(picker).toContain("정확한 도로명 주소로 찾기");
  });
});

describe("C. 검색 결과 선택 시 좌표/주소가 함께 갱신된다", () => {
  const fn = picker.slice(picker.indexOf("function pickResult"), picker.indexOf("// 정확한 도로명 주소로 찾기"));
  it("pickResult가 movePin(좌표)과 setResolvedAddress(주소)를 모두 호출한다", () => {
    expect(fn).toContain("movePin(r.lat, r.lng)");
    expect(fn).toContain("setResolvedAddress(r.road ?? r.displayName)");
  });
});

describe("D. 상세주소는 좌표에 전혀 영향을 주지 않는다", () => {
  it("rooms 페이지에서 상세주소 input의 onChange는 setDetailAddress만 호출하고 setLat/setLng를 호출하지 않는다", () => {
    const block = roomsPage.slice(roomsPage.indexOf('aria-label="상세주소"'), roomsPage.indexOf('aria-label="상세주소"') + 300);
    expect(block).toContain("setDetailAddress(e.target.value)");
    expect(block).not.toMatch(/setLat|setLng/);
  });

  it("handleSave가 보내는 입력값에서 detailAddress와 latitude/longitude는 서로 다른 소스(state)다", () => {
    const fn = roomsPage.slice(roomsPage.indexOf("async function handleSave"), roomsPage.indexOf("async function handleDelete"));
    expect(fn).toContain("detailAddress: detailAddress.trim()");
    expect(fn).toContain("latitude: lat, longitude: lng");
  });

  it("lib/rooms.ts의 update/insert 모두 detail_address를 latitude/longitude와 별개 필드로 보낸다", () => {
    expect(roomsLib).toMatch(/detail_address: input\.detailAddress \|\| null,[\s\S]{0,80}latitude: input\.latitude,/);
  });
});

describe("E. 지도 직접 클릭(기존 기능)이 그대로 보존된다", () => {
  it("map.on(\"click\", ...)에서 movePin으로 좌표를 즉시 반영한다(기존 그대로)", () => {
    const block = picker.slice(picker.indexOf('map.on("click"'), picker.indexOf('map.on("click"') + 600);
    expect(block).toContain("movePin(lat, lng)");
  });

  it("역지오코딩은 좌표 지정 이후 별도로 시도되고, 실패해도 좌표 지정 자체를 막지 않는다(resolvedAddress만 null)", () => {
    const block = picker.slice(picker.indexOf('map.on("click"'), picker.indexOf('map.on("click"') + 900);
    expect(block).toMatch(/movePin\(lat, lng\);[\s\S]*await reverseGeocode\(lat, lng\)/);
  });

  it("역지오코딩 실패(undefined)는 기존 주소를 덮지 않는다 — rooms 페이지 onPick이 addr 유무를 분기한다", () => {
    const fn = roomsPage.slice(roomsPage.indexOf("onPick={(la, ln, addr)"), roomsPage.indexOf("onClose={() => setMapPicker(false)}"));
    expect(fn).toMatch(/if \(addr\) setAddress\(addr\);/);
  });
});

describe("F. 상세주소 DB 저장 — 신규 컬럼, 기존 address와 분리, concat 없음", () => {
  it("rooms.detail_address는 별도 컬럼이다(기존 address 문자열에 이어붙이지 않음)", () => {
    expect(roomsLib).not.toMatch(/address\s*\+\s*input\.detailAddress|detailAddress\s*\+\s*input\.address/);
    expect(migration).toContain("alter table rooms add column if not exists detail_address text");
  });

  it("migration은 새 파일로만 준비되고, 이 세션에서 production에 실행하지 않았다고 명시한다", () => {
    expect(migration).toMatch(/production에 실행하지 않았습니다/);
  });

  it("detail_address 컬럼이 아직 없어도(42703) 룸 조회/저장이 깨지지 않도록 방어 처리가 있다", () => {
    expect(roomsLib).toContain('const MISSING_COLUMN = "42703"');
    expect((roomsLib.match(/error\.code === MISSING_COLUMN/g) ?? []).length).toBeGreaterThanOrEqual(3); // fetch/add/update
  });
});

describe("G. 룸 수정 시 기존 위치/주소/상세주소를 복원한다(회귀 없음)", () => {
  it("openEdit이 address/detailAddress/lat/lng를 모두 기존 값으로 채운다", () => {
    const fn = roomsPage.slice(roomsPage.indexOf("function openEdit"), roomsPage.indexOf("function closeSheet"));
    expect(fn).toContain('setAddress(r.address ?? "")');
    expect(fn).toContain('setDetailAddress(r.detailAddress ?? "")');
    expect(fn).toContain("setLat(r.latitude)");
    expect(fn).toContain("setLng(r.longitude)");
  });

  it("MapPicker를 다시 열 때 기존 좌표(initialLat/Lng)로 핀이 복원된다(기존 로직 유지)", () => {
    expect(roomsPage).toContain("initialLat={lat}");
    expect(roomsPage).toContain("initialLng={lng}");
  });
});

describe("H. 에러/빈 상태 메시지는 전부 한글이고 raw 오류를 그대로 노출하지 않는다", () => {
  it("빈 검색어/결과 없음/네트워크 실패 메시지가 한글로 존재한다", () => {
    expect(picker).toContain("검색어를 입력해 주세요.");
    expect(picker).toContain("검색 결과가 없어요. 도로명이나 건물명을 다시 확인해 주세요.");
    expect(geocodingLib).toContain("주소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
  });

  it("catch 블록이 e.message를 직접 노출하지 않고 폴백 한글 메시지를 우선한다", () => {
    const catches = picker.match(/catch \(e: any\) \{[\s\S]{0,120}?\}/g) ?? [];
    expect(catches.length).toBeGreaterThan(0);
    for (const block of catches) expect(block).toMatch(/toUserMessage\(e,\s*"[가-힣]/);   // 한글 폴백을 가진 toUserMessage로 raw SDK 오류를 가린다(2026-10-06)
  });
});

describe("I/J. 기존 룸 생성/수정 저장은 주소 없이도, 좌표 없이도 실패하지 않는다(회귀 없음)", () => {
  it("handleSave의 유일한 필수값 검증은 이름뿐이다(주소/좌표 필수 아님)", () => {
    const fn = roomsPage.slice(roomsPage.indexOf("async function handleSave"), roomsPage.indexOf("async function handleDelete"));
    expect(fn).toContain('if (!name.trim())');
    expect(fn).not.toMatch(/if \(!address|if \(!lat|if \(!lng/);
  });

  it("addRoom/updateRoom은 address/detailAddress/좌표가 비어도(null) 그대로 저장을 시도한다", () => {
    expect(roomsLib).toContain("latitude: input.latitude,");
    expect(roomsLib).toContain("longitude: input.longitude,");
  });
});

describe("K. iOS 입력 확대 버그 — 새 검색/상세주소 input도 이미 16px인 .input-field를 재사용한다", () => {
  it("새 검색 input과 상세주소 input이 .input-field 클래스를 쓴다(새 CSS 클래스를 따로 만들지 않음)", () => {
    expect(picker).toMatch(/placeholder="장소명 또는 도로명 주소 검색"[\s\S]{0,40}/);
    const searchInputBlock = picker.slice(picker.indexOf('placeholder="장소명 또는 도로명 주소 검색"') - 80, picker.indexOf('placeholder="장소명 또는 도로명 주소 검색"'));
    expect(searchInputBlock).toContain('className="input-field"');

    const detailInputBlock = roomsPage.slice(roomsPage.indexOf('aria-label="상세주소"') - 10, roomsPage.indexOf('aria-label="상세주소"') + 120);
    expect(detailInputBlock).toContain('className="input-field"');
  });

  it(".input-field는 여전히 16px 이상이다(기존 iOS 확대 버그 fix 회귀 없음)", () => {
    const block = css.slice(css.indexOf("\n.input-field {"), css.indexOf("\n.input-field {") + 400);
    expect(block).toMatch(/font-size:\s*16px/);
  });

  it("이번 변경은 maximum-scale=1/user-scalable=no 등 확대 차단 우회책을 쓰지 않았다", () => {
    expect(css).not.toMatch(/@viewport\s*\{/);
    expect(picker).not.toMatch(/user-scalable|maximum-scale/i);
    expect(roomsPage).not.toMatch(/user-scalable|maximum-scale/i);
  });
});

describe("새 색상/새 지도 라이브러리 미도입 확인", () => {
  it("MapPicker는 여전히 Leaflet + OpenStreetMap만 쓴다(새 지도 SDK 없음)", () => {
    expect(picker).toContain("unpkg.com/leaflet@1.9.4");
    expect(picker).not.toMatch(/google\.maps|kakao\.maps|naver\.maps/i);
  });

  it("검색 결과 목록에 하드코딩된 새 색상이 없다(기존 토큰만 재사용)", () => {
    expect(css).not.toMatch(/\.map-search-result[^{]*\{[^}]*#[0-9a-fA-F]{3,6}/);
  });
});
