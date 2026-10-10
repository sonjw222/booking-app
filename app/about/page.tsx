import type { Metadata } from "next";
import Link from "next/link";
import { BUSINESS_INFO } from "../../lib/businessInfo";
import { SITE_URL, SITE_DESCRIPTION, STORE_LINKS } from "../../lib/siteMeta";

/*
  회사·서비스 소개 — 로그인 없이 누구나(외부 심사자·검색 크롤러 포함) 볼 수 있는 서버 렌더링 페이지.
  서비스 소개는 실제로 구현되어 운영 중인 기능만 쓴다. 사업자 정보(상호/대표자/등록번호/주소)는 중복 노출하지 않고
  /legal/business로 연결하며, 이 페이지에는 BUSINESS_INFO의 상호·영문 브랜드명·공개 문의 이메일만 쓴다.
  영문 브랜드명 MWHABIT은 별도 법인명이 아니라 등록 상호 "모하빗"의 서비스 브랜드 표기다.
*/

const TITLE = "회사·서비스 소개";
const DESCRIPTION = SITE_DESCRIPTION;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/about" },
  openGraph: { type: "website", url: "/about", title: `${TITLE} | 모하빗 (MWHABIT)`, description: DESCRIPTION, locale: "ko_KR", siteName: "모하빗 (MWHABIT)" },
};

// 확인된 사실만: 이름/영문 브랜드명/URL/공개 문의 이메일(+확인된 스토어 링크).
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: BUSINESS_INFO.companyName,
  alternateName: BUSINESS_INFO.brandNameEn,
  url: SITE_URL,
  email: BUSINESS_INFO.email,
  ...(STORE_LINKS.appStore || STORE_LINKS.googlePlay
    ? { sameAs: [STORE_LINKS.appStore, STORE_LINKS.googlePlay].filter((u): u is string => !!u) }
    : {}),
};

export default function AboutPage() {
  return (
    <div className="app-shell settings-page-v2">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />

      <div className="back-header">
        <Link className="side" href="/" prefetch={false}>‹</Link>
        <div className="title">{TITLE}</div>
        <div className="side" />
      </div>

      <div className="legal-page">
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: "4px 0 8px" }}>
          {BUSINESS_INFO.serviceName} ({BUSINESS_INFO.brandNameEn})
        </h1>
        <p>
          {BUSINESS_INFO.serviceName}({BUSINESS_INFO.brandNameEn})은 스포츠·취미 클래스 탐색과 예약을 지원하고,
          센터 운영자가 수업·회원·예약 등을 관리할 수 있도록 돕는 서비스입니다.
        </p>

        <h2>제공 기능</h2>
        <ul>
          <li>스포츠·취미 클래스 탐색과 센터·수업 정보 확인</li>
          <li>클래스 예약과 예약 내역, 회원권(수강권) 관리</li>
          <li>센터 운영자를 위한 수업·회원·예약·출석 관리 기능</li>
        </ul>
        <p>위 기능은 현재 서비스에서 제공 중인 기능입니다.</p>

        <h2>운영 주체</h2>
        <table>
          <tbody>
            <tr><th>등록 상호</th><td>{BUSINESS_INFO.companyName} (서비스 브랜드: {BUSINESS_INFO.brandNameEn})</td></tr>
            <tr><th>사업자 정보</th><td><Link href="/legal/business" prefetch={false}>사업자 정보 보기</Link></td></tr>
            <tr><th>고객 문의</th><td>{BUSINESS_INFO.email}</td></tr>
            <tr><th>웹사이트</th><td>{SITE_URL}</td></tr>
          </tbody>
        </table>

        {(STORE_LINKS.appStore || STORE_LINKS.googlePlay) && (
          <>
            <h2>앱 다운로드</h2>
            <ul>
              {STORE_LINKS.appStore && <li><a href={STORE_LINKS.appStore} rel="noopener noreferrer">App Store에서 보기</a></li>}
              {STORE_LINKS.googlePlay && <li><a href={STORE_LINKS.googlePlay} rel="noopener noreferrer">Google Play에서 보기</a></li>}
            </ul>
          </>
        )}

        <h2>About (English)</h2>
        <p>
          {BUSINESS_INFO.brandNameEn} ({BUSINESS_INFO.serviceName}) is an online service for discovering and booking sports and
          hobby classes, and for class studios and gyms to manage their classes, members and reservations.
          {BUSINESS_INFO.brandNameEn} is the service brand name of the Korean business registered as &quot;{BUSINESS_INFO.companyName}&quot;
          (a business registered in Korea; see <Link href="/legal/business" prefetch={false}>business information</Link>, in Korean).
          Contact: {BUSINESS_INFO.email}
        </p>

        <h2>약관 및 정책</h2>
        <ul>
          <li><Link href="/legal/terms" prefetch={false}>이용약관</Link></li>
          <li><Link href="/legal/privacy" prefetch={false}>개인정보처리방침</Link></li>
          <li><Link href="/legal/refund" prefetch={false}>환불·취소 정책</Link></li>
          <li><Link href="/legal/business" prefetch={false}>사업자 정보</Link></li>
        </ul>
      </div>
    </div>
  );
}
