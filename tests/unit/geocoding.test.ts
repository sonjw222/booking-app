/*
  lib/geocoding.ts — Nominatim 검색/역지오코딩 wrapper 단위 테스트.
  실제 네트워크 호출은 하지 않는다(vi.stubGlobal("fetch", ...)로 스텁 — 이 프로젝트
  기존 관례, tests/unit/billing.confirm.test.ts 참고).
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchAddress, geocodeAddress, reverseGeocode } from "../../lib/geocoding";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: any, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("searchAddress — 장소명/도로명 주소 통합 검색(결과 여러 개)", () => {
  it("빈 검색어는 네트워크 호출 없이 빈 배열을 반환한다", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await searchAddress("   ")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("여러 결과를 모두 반환한다(첫 결과만 취하지 않음 — 이전 버그 회귀 방지)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([
      { lat: "37.1", lon: "127.1", display_name: "A", address: { road: "강남대로", house_number: "123" } },
      { lat: "37.2", lon: "127.2", display_name: "B", address: { road: "서초대로" } },
      { lat: "37.3", lon: "127.3", display_name: "C", address: {} },
    ])));
    const results = await searchAddress("강남대로 123", 5);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ lat: 37.1, lng: 127.1, displayName: "A", road: "강남대로 123", jibun: null });
  });

  it("검색 URL에 limit을 전달한다(기본 1개만 가져오던 이전 버그 회귀 방지)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchSpy);
    await searchAddress("교대역", 5);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("limit=5");
    expect(calledUrl).not.toContain("limit=1&");
  });

  it("결과 0건이어도 빈 배열을 반환한다(호출부가 '검색 결과가 없어요' 메시지를 붙임)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    expect(await searchAddress("존재하지않는주소")).toEqual([]);
  });

  it("네트워크 오류 시 사용자용 한글 메시지로 던진다(raw 오류 노출 없음)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(searchAddress("강남")).rejects.toThrow("주소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
  });

  it("HTTP 오류 응답(ok=false)도 사용자용 한글 메시지로 던진다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([], false)));
    await expect(searchAddress("강남")).rejects.toThrow("주소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
  });
});

describe("geocodeAddress — 다음 우편번호가 준 정확한 도로명주소에 좌표를 붙인다", () => {
  it("결과가 있으면 첫 번째 좌표를 반환한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([
      { lat: "37.5", lon: "127.0", display_name: "X", address: { road: "테헤란로" } },
    ])));
    const geo = await geocodeAddress("서울특별시 강남구 테헤란로 123");
    expect(geo).toEqual({ lat: 37.5, lng: 127.0, displayName: "X", road: "테헤란로", jibun: null });
  });

  it("좌표를 못 찾아도 예외를 던지지 않고 null을 반환한다(주소 확보 자체는 막지 않음)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    expect(await geocodeAddress("도로명주소이지만 좌표매칭 실패")).toBeNull();
  });

  it("네트워크 오류가 나도 예외를 던지지 않고 null을 반환한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await geocodeAddress("아무 주소")).toBeNull();
  });
});

describe("reverseGeocode — 좌표 → 주소(지도 직접 클릭, 최선 노력)", () => {
  it("성공하면 display_name을 반환한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ display_name: "서울특별시 서초구 서초대로 123" })));
    expect(await reverseGeocode(37.1, 127.1)).toBe("서울특별시 서초구 서초대로 123");
  });

  it("결과가 없으면 null을 반환한다(예외를 던지지 않음 — 좌표 저장을 막지 않기 위함)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    expect(await reverseGeocode(37.1, 127.1)).toBeNull();
  });

  it("네트워크 오류가 나도 null을 반환한다(예외 없음)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await reverseGeocode(37.1, 127.1)).toBeNull();
  });

  it("HTTP 오류 응답이면 null을 반환한다(예외 없음)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false)));
    expect(await reverseGeocode(37.1, 127.1)).toBeNull();
  });
});
