// 다음(카카오) 우편번호 서비스 — 도로명주소 검색 팝업.
// 공식 배포 스크립트를 그때그때 필요할 때만(주소 검색 버튼을 처음 누를 때) 동적으로 로드한다.
// 참고: https://postcode.map.daum.net/guide

declare global {
  interface Window {
    daum?: {
      Postcode: new (options: {
        oncomplete: (data: DaumPostcodeData) => void;
        onclose?: () => void;
      }) => { open: () => void };
    };
  }
}

type DaumPostcodeData = {
  roadAddress: string;
  jibunAddress: string;
  zonecode: string;
};

const SCRIPT_SRC = "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";

let loadPromise: Promise<void> | null = null;

function loadDaumPostcodeScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("브라우저에서만 사용할 수 있어요"));
  if (window.daum?.Postcode) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.onload = () => resolve();
    script.onerror = () => {
      loadPromise = null;
      reject(new Error("주소 검색 서비스를 불러오지 못했어요"));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}

export type DaumAddressResult = { roadAddress: string; zonecode: string };

// 팝업을 연다. 사용자가 주소를 선택하면 onComplete, 선택 없이 팝업을 닫으면 onClose가 불린다
// (콜백 방식 — 취소 시 영영 안 끝나는 promise가 되는 걸 피하기 위해 promise를 쓰지 않는다).
export async function openDaumPostcode(
  onComplete: (result: DaumAddressResult) => void,
  onClose?: () => void
): Promise<void> {
  await loadDaumPostcodeScript();
  new window.daum!.Postcode({
    oncomplete: (data) => onComplete({ roadAddress: data.roadAddress || data.jibunAddress, zonecode: data.zonecode }),
    onclose: onClose,
  }).open();
}
