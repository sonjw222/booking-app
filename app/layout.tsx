import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppConfirmProvider from "./components/AppConfirmProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "우리동네 클래스",
    template: "%s · 우리동네 클래스",
  },
  description: "주변의 스포츠와 취미 클래스를 찾고 간편하게 예약하세요.",
  applicationName: "우리동네 클래스",
};

export const viewport: Viewport = {
  themeColor: "#0A2545",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <AppConfirmProvider />
      </body>
    </html>
  );
}
