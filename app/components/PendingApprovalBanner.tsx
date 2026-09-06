"use client";

/*
  센터 승인 대기 안내 배너
  - centers.status가 'pending'/'rejected'이면 회원 화면(lib/center.ts)엔 전혀 안 보이는데,
    매니저는 소속만 active면 수업/수강권/스태프를 다 세팅할 수 있어 이 사실을 모르고
    지나치기 쉬웠다(2026-09-06 UX 감사) — 매니저 화면 전체에 눈에 띄게 안내한다.
  - app/manager/layout.tsx에서 모든 /manager/* 페이지에 공통으로 띄운다.
*/

import { useEffect, useState } from "react";
import { fetchMyCenters, type ManagedCenter } from "../../lib/manager";

export default function PendingApprovalBanner() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);

  useEffect(() => {
    fetchMyCenters().then(setCenters).catch(() => { /* 로그인/권한 오류는 각 페이지가 이미 처리함 */ });
  }, []);

  const notApproved = centers.filter((c) => c.approvalStatus !== "approved");
  if (notApproved.length === 0) return null;

  return (
    <div className="perm-guide is-warning" style={{ margin: "10px 20px 0" }}>
      {notApproved.map((c) => (
        <div key={c.id}>
          <b>{c.name}</b>
          {c.approvalStatus === "rejected"
            ? "센터는 운영자 승인이 거절됐어요. 회원 화면에 노출되지 않아요."
            : "센터는 아직 운영자 승인 대기 중이에요. 승인 전까지는 회원 화면에 노출되지 않으니, 지금 수업·수강권을 준비해두셔도 회원은 아직 볼 수 없어요."}
        </div>
      ))}
    </div>
  );
}
