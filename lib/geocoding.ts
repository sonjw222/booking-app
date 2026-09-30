/*
  주소 ↔ 좌표 변환 (OpenStreetMap Nominatim, API 키 불필요)
  - app/manager/center-info/MapPicker.tsx가 "장소명 또는 도로명 주소 검색"과
    지도 클릭 시 역지오코딩(좌표→주소)에 공용으로 쓴다.
  - Nominatim은 무료/키 불필요지만, 한국 도로명주소 인식 정확도가 다음(카카오)
    우편번호 서비스보다 떨어진다(실측 확인 — 건물명·역명 등 POI는 비교적 잘 맞지만,
    공식 도로명주소 형식 매칭은 들쭉날쭉). 그래서 정확한 도로명주소가 필요하면
    lib/daumPostcode.ts(이미 존재, 회원가입 폼이 쓰는 것과 동일)를 같이 제공하고,
    거기서 받은 주소 문자열만 이 모듈로 좌표를 붙인다(geocodeAddress).
*/

export type GeocodeResult = {
  lat: number;
  lng: number;
  displayName: string;
  road: string | null;
  jibun: string | null;
};

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

function buildDisplayParts(d: any): { road: string | null; jibun: string | null } {
  const a = d.address ?? {};
  const road = [a.road, a.house_number].filter(Boolean).join(" ") || null;
  const jibun = a.city_district || a.borough || a.suburb || a.city || a.town || a.village || null;
  return { road, jibun };
}

// 장소명/도로명주소 통합 검색 — 결과를 여러 개 반환한다(첫 결과만 취하지 않음 —
// 이전 버전의 버그: limit=1로 사용자가 고를 기회 자체가 없었다).
export async function searchAddress(query: string, limit = 5): Promise<GeocodeResult[]> {
  const q = query.trim();
  if (!q) return [];
  let res: Response;
  try {
    res = await fetch(
      `${NOMINATIM_BASE}/search?format=json&addressdetails=1&limit=${limit}&countrycodes=kr&q=${encodeURIComponent(q)}`,
      { headers: { "Accept-Language": "ko" } }
    );
  } catch {
    throw new Error("주소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
  if (!res.ok) throw new Error("주소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
  let data: any[];
  try {
    data = await res.json();
  } catch {
    throw new Error("주소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
  return (data ?? []).map((d) => {
    const { road, jibun } = buildDisplayParts(d);
    return { lat: parseFloat(d.lat), lng: parseFloat(d.lon), displayName: d.display_name as string, road, jibun };
  });
}

// 다음 우편번호 팝업에서 받은 정확한 도로명주소 문자열에 좌표를 붙인다.
// 결과가 없어도 에러를 던지지 않고 null을 반환 — 주소는 이미 정확히 확보했으니
// 좌표만 못 찾았다고 전체 흐름을 막지 않기 위함(호출부에서 "좌표는 지도를 눌러
// 직접 지정해주세요" 안내로 이어짐).
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  try {
    const results = await searchAddress(address, 1);
    return results[0] ?? null;
  } catch {
    return null;
  }
}

// 좌표 → 주소 (지도 직접 클릭 시 최선 노력으로 주소를 채움). 실패해도 null만
// 반환하고 예외를 던지지 않는다 — 좌표 저장 자체를 절대 막으면 안 되기 때문.
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(
      `${NOMINATIM_BASE}/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}`,
      { headers: { "Accept-Language": "ko" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.display_name ?? null;
  } catch {
    return null;
  }
}
