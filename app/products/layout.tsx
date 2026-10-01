import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "판매 상품 | 모하빗",
  description: "모하빗에서 판매 중인 센터별 수강권·상품 안내",
};

export default function ProductsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
