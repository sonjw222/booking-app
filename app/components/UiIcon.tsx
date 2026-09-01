import type { ReactNode } from "react";

export type IconName =
  | "home" | "calendar" | "list" | "bell" | "user" | "search" | "ticket"
  | "users" | "message" | "palette" | "building" | "logout" | "receipt"
  | "shield" | "settings" | "sliders" | "location" | "clock" | "edit"
  | "megaphone" | "info" | "alert" | "check" | "grid" | "star"
  | "phone" | "cart" | "paperclip" | "close"
  | "card" | "bank" | "handshake"
  | "pilates" | "skate" | "ballet" | "rhythm" | "yoga" | "boxing" | "swim" | "golf";

export default function UiIcon({ name, size = 22 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V21h13V10.5M9.5 21v-6h5v6"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></>,
    list: <><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21c.7-4.2 3.3-6 8-6s7.3 1.8 8 6"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></>,
    ticket: <><path d="M4 6h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4V6Z"/><path d="M12 8v8"/></>,
    users: <><circle cx="9" cy="9" r="3"/><path d="M3.5 20c.5-3.5 2.4-5 5.5-5s5 1.5 5.5 5M16 6.5a3 3 0 0 1 0 5.8M16.5 15c2.5.2 3.8 1.7 4 4"/></>,
    message: <path d="M4 5h16v11H9l-5 4V5Z"/>,
    palette: <><path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h4a5 5 0 0 0 5-5c0-3-4-5-9-5Z"/><circle cx="7.5" cy="9" r=".8" fill="currentColor"/><circle cx="10" cy="6.5" r=".8" fill="currentColor"/></>,
    building: <><path d="M4 21V5h11v16M15 10h5v11M8 9h3M8 13h3M8 17h3"/></>,
    logout: <><path d="M10 4H5v16h5M14 8l4 4-4 4M8 12h10"/></>,
    receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/></>,
    shield: <path d="M12 3 20 6v5c0 5-3.4 8.2-8 10-4.6-1.8-8-5-8-10V6l8-3Z"/>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    sliders: <><path d="M4 6h5M13 6h7M4 12h10M18 12h2M4 18h3M11 18h9"/><circle cx="11" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/></>,
    location: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></>,
    edit: <><path d="M14 5 19 10 9 20H4v-5L14 5Z"/><path d="m12 7 5 5"/></>,
    megaphone: <><path d="M4 11v4h4l8 4V7L8 11H4Z"/><path d="M8 15l1 5"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
    alert: <><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17h.01"/></>,
    check: <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16.5 9"/></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
    star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>,
    phone: <path d="M7 3.5 9.2 8 7.4 9.8a12 12 0 0 0 5.6 5.6L15 13.6l4.5 2.2v3.1c0 1-.8 1.7-1.8 1.6C9.9 19.9 4.1 14.1 3.1 5.8 3 4.8 3.7 4 4.7 4h2.3Z"/>,
    cart: <><path d="M3 4h2.2l2.4 10.4h9.6L20 7H6"/><circle cx="9.5" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/></>,
    paperclip: <path d="M18.5 11 12 17.5a4 4 0 0 1-5.7-5.7l7-7a2.8 2.8 0 0 1 4 4l-7 7a1.6 1.6 0 0 1-2.2-2.2l6.3-6.3"/>,
    card: <><rect x="2.5" y="5.5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6 15h5"/></>,
    bank: <><path d="M12 3 21 9H3l9-6Z"/><path d="M5 9v9M9 9v9M15 9v9M19 9v9"/><path d="M3 21h18"/></>,
    handshake: <><path d="M2.5 12.5 6 10l3 2.2L12 10l3 2.2 3-2.2 3.5 2.5"/><path d="M8 12.5l3 3a1.8 1.8 0 0 0 2.6 0l3-3"/></>,
    close: <path d="M6 6l12 12M18 6 6 18"/>,
    pilates: <g transform="scale(.24)" stroke="none"><rect fill="currentColor" x="8" y="70" width="84" height="10" rx="5"/><rect fill="var(--brand-ink)" x="15" y="57" width="43" height="12" rx="6"/><rect fill="var(--brand)" x="61" y="42" width="10" height="28" rx="5"/><rect fill="currentColor" x="74" y="25" width="7" height="46" rx="3.5"/><rect fill="currentColor" x="68" y="23" width="20" height="7" rx="3.5"/><path fill="currentColor" d="M19 79h7l-4 14h-7Zm55 0h7l5 14h-7Z"/><circle fill="var(--brand)" cx="23" cy="51" r="9"/></g>,
    skate: <><path d="M8 4v10h9l2 3H8c-3 0-4-2-4-4V8"/><path d="M8 8h5M9 20h8"/></>,
    ballet: <g transform="scale(.24)" stroke="none"><path fill="currentColor" d="M17 8h19v39c8 7 12 18 12 34 0 9-5 14-14 14-10 0-15-6-15-17Z"/><path d="M17 18 36 31M17 39l19-14M18 48l20 13" fill="none" stroke="var(--bg)" strokeWidth="5"/><path fill="var(--brand)" d="M20 78c8 3 17 3 27-1v7c-2 7-7 11-14 11-8 0-13-5-13-12Z"/><g transform="rotate(-13 68 52)"><path fill="var(--brand-ink)" d="M58 8h19v39c8 7 12 18 12 34 0 9-5 14-14 14-10 0-15-6-15-17Z"/><path d="M58 18 77 31M58 39l19-14M59 48l20 13" fill="none" stroke="var(--bg)" strokeWidth="5"/><path fill="var(--brand)" d="M61 78c8 3 17 3 27-1v7c-2 7-7 11-14 11-8 0-13-5-13-12Z"/></g></g>,
    rhythm: <g transform="scale(.24)" fill="none" strokeLinecap="round"><circle cx="61" cy="47" r="27" stroke="currentColor" strokeWidth="8"/><path d="M25 19c22 5 23 17 4 24S9 61 30 65s20 15 2 24" stroke="var(--brand)" strokeWidth="8"/><rect x="18" y="10" width="6" height="30" rx="3" transform="rotate(-18 21 25)" fill="var(--brand-ink)" stroke="none"/></g>,
    yoga: <g transform="scale(.24)" stroke="none"><rect fill="var(--brand)" x="9" y="85" width="82" height="9" rx="4.5"/><circle fill="currentColor" cx="50" cy="21" r="9"/><path fill="currentColor" d="M39 34c4-5 18-5 22 0l5 32H34Z"/><path fill="currentColor" d="M41 38 17 65l8 8 25-22 25 22 8-8-24-27Z"/><path fill="currentColor" d="M48 60C31 59 18 66 8 79c13 8 28 7 45-2l4-9Z"/><path fill="var(--brand-ink)" d="M52 60c17-1 30 6 40 19-13 8-28 7-45-2l-4-9Z"/></g>,
    boxing: <g transform="scale(.24)" stroke="none"><path fill="currentColor" d="M66 6h7v16h-7Z"/><rect fill="currentColor" x="57" y="18" width="25" height="7" rx="3.5"/><rect fill="var(--brand-ink)" x="56" y="24" width="28" height="61" rx="14"/><path fill="var(--brand)" d="M56 43h28v12H56Z"/><path fill="currentColor" d="M18 48c0-11 7-18 17-18 9 0 15 5 15 13 0 7-4 11-10 13l-2 13H21l-1-10c-2-3-2-7-2-11Z"/><path fill="var(--brand)" d="M38 37c6 1 12 5 18 11l-7 10c-6-5-11-8-17-9Z"/><rect fill="currentColor" x="17" y="67" width="23" height="10" rx="5"/></g>,
    swim: <><path d="M3 15c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 2-1M3 19c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 2-1"/><circle cx="15" cy="6" r="2"/><path d="m5 13 5-5 6 4"/></>,
    golf: <><path d="M7 3v15M7 4l9 3-9 3M4 21c4-2 8-2 12 0"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
