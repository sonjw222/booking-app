"use client";

/*
  Track 1/8 — 앱 전체 공용 이미지 확대(Lightbox) 컴포넌트.
  - RootLayout에서 한 번만 <ImageViewerProvider>로 감싸두면, 어떤 페이지에서도
    <ZoomableImage>만 쓰면 자동으로 확대 기능이 적용된다(새 페이지 추가 시 별도 모달
    상태 관리 불필요 — 구조 개선 요구사항).
  - 여러 장(review/announcement 사진 등)은 group/groupIndex를 넘기면 그 안에서
    좌우 스와이프·화살표로 이동한다. 한 장짜리(센터 사진/프로필 아바타 등)는 group을
    생략하면 자기 자신 하나만 보여준다.
  - 지원: 확대(더블클릭/휠/핀치), 축소, 닫기(X/ESC/바깥 클릭), 모바일 스와이프(좌우 넘기기).
*/

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type ViewerState = { images: string[]; index: number } | null;

const ImageViewerContext = createContext<{ open: (images: string[], index: number) => void } | null>(null);

export function ImageViewerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ViewerState>(null);
  const [scale, setScale] = useState(1);
  const touchStartX = useRef<number | null>(null);
  const pinchStartDist = useRef<number | null>(null);
  const pinchStartScale = useRef(1);

  const open = useCallback((images: string[], index: number) => {
    setState({ images, index });
    setScale(1);
  }, []);
  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (!state) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    }
    window.addEventListener("keydown", onKey);
    // 열려있는 동안 배경 스크롤 방지
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, close]);

  function prev() {
    setState((s) => (s ? { ...s, index: (s.index - 1 + s.images.length) % s.images.length } : s));
    setScale(1);
  }
  function next() {
    setState((s) => (s ? { ...s, index: (s.index + 1) % s.images.length } : s));
    setScale(1);
  }

  function dist(t: TouchList) {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.hypot(dx, dy);
  }

  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      pinchStartDist.current = dist(e.touches as unknown as TouchList);
      pinchStartScale.current = scale;
      touchStartX.current = null;
    } else if (e.touches.length === 1) {
      touchStartX.current = e.touches[0].clientX;
      pinchStartDist.current = null;
    }
  }
  function onTouchMove(e: React.TouchEvent) {
    if (e.touches.length === 2 && pinchStartDist.current) {
      const ratio = dist(e.touches as unknown as TouchList) / pinchStartDist.current;
      setScale(Math.min(4, Math.max(1, pinchStartScale.current * ratio)));
    }
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (scale > 1) return; // 확대 중엔 스와이프로 넘기지 않음(핀치/드래그와 충돌 방지)
    if (Math.abs(dx) > 50 && state && state.images.length > 1) {
      if (dx > 0) prev(); else next();
    }
  }

  return (
    <ImageViewerContext.Provider value={{ open }}>
      {children}
      {state && (
        <div className="image-viewer-overlay" onClick={close}>
          <button className="image-viewer-close" onClick={close} aria-label="닫기">×</button>
          {state.images.length > 1 && (
            <>
              <button
                className="image-viewer-nav prev"
                onClick={(e) => { e.stopPropagation(); prev(); }}
                aria-label="이전 사진"
              >‹</button>
              <button
                className="image-viewer-nav next"
                onClick={(e) => { e.stopPropagation(); next(); }}
                aria-label="다음 사진"
              >›</button>
            </>
          )}
          <img
            className="image-viewer-img"
            src={state.images[state.index]}
            alt=""
            style={{ transform: `scale(${scale})` }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => { e.stopPropagation(); setScale((v) => (v > 1 ? 1 : 2)); }}
            onWheel={(e) => {
              e.stopPropagation();
              setScale((v) => Math.min(4, Math.max(1, v - e.deltaY * 0.01)));
            }}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          />
          {state.images.length > 1 && (
            <div className="image-viewer-counter">{state.index + 1} / {state.images.length}</div>
          )}
        </div>
      )}
    </ImageViewerContext.Provider>
  );
}

export function useImageViewer() {
  const ctx = useContext(ImageViewerContext);
  if (!ctx) throw new Error("useImageViewer는 ImageViewerProvider 안에서만 쓸 수 있어요");
  return ctx;
}

// 어떤 페이지든 <img> 대신 이것만 쓰면 자동으로 확대 기능이 적용된다.
// group을 넘기면(같은 갤러리의 전체 URL 목록) 그 안에서 좌우로 넘겨볼 수 있다.
export function ZoomableImage({
  src, alt = "", className, group, groupIndex,
}: {
  src: string;
  alt?: string;
  className?: string;
  group?: string[];
  groupIndex?: number;
}) {
  const { open } = useImageViewer();
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      onClick={() => open(group && group.length > 0 ? group : [src], group ? (groupIndex ?? 0) : 0)}
      style={{ cursor: "zoom-in" }}
    />
  );
}
