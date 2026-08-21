"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "tertiary" | "danger";
  children: ReactNode;
};

export default function AppButton({ variant = "primary", className = "", children, type = "button", ...props }: Props) {
  return <button type={type} className={`app-button app-button-${variant} ${className}`.trim()} {...props}>{children}</button>;
}
