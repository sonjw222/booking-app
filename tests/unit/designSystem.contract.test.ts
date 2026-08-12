import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Batch 1 design system contract", () => {
  it("keeps the approved neutral and sky-blue tokens centralized", () => {
    const css = read("app/globals.css");
    expect(css).toContain("--bg: #FBFBFA");
    expect(css).toContain("--ink: #171719");
    expect(css).toContain("--brand: #45BFE3");
    expect(css).toContain("--brand-ink: #087A9C");
    expect(css).toContain("--brand-soft: #E6F7FC");
    expect(css).toContain("--page-gutter: 16px");
  });

  it("provides every shared primitive without wiring it into feature pages", () => {
    for (const component of [
      "AppButton", "AppConfirmProvider", "ConfirmDialog", "DatePicker",
      "EmptyState", "SegmentedTabs", "UiIcon",
    ]) {
      expect(() => read(`app/components/${component}.tsx`)).not.toThrow();
    }
    const layout = read("app/layout.tsx");
    expect(layout).toContain("SessionWatcher");
    expect(layout).toContain("ImageViewerProvider");
    expect(layout).toContain("AppConfirmProvider");
  });
});

describe("Batch 3 discovery design contract", () => {
  it("uses the shared icon system across home, search and category discovery", () => {
    expect(read("app/page.tsx")).toContain("<UiIcon");
    expect(read("app/search/page.tsx")).toContain("<UiIcon");
    expect(read("app/category/[label]/page.tsx")).toContain("<UiIcon");
  });

  it("preserves the latest OAuth error callback behavior on home", () => {
    const home = read("app/page.tsx");
    expect(home).toContain("error_description");
    expect(home).toContain("window.location.replace(`/login?oauth_error=");
    expect(home).toContain("fetchMyUpcomingClasses");
  });
});

describe("Batch 2 chrome layer contract", () => {
  it("keeps persistent chrome below modal and sheet overlays", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.bottom-nav\s*\{[\s\S]*?z-index:\s*45;/);
    expect(css).toMatch(/\.manager-chrome\s*\{[\s\S]*?z-index:\s*30;/);
    expect(css).toMatch(/\.admin-chrome\s*\{[\s\S]*?z-index:\s*30;/);
    expect(css).toMatch(/\.sheet-overlay\s*\{[\s\S]*?z-index:\s*60;/);
    expect(css).toContain(".back-header:has(.header-action)");
  });
});

describe("Batch 4 reservation design contract", () => {
  it("uses the shared booking controls without removing current reservation features", () => {
    const reservation = read("app/reservation/page.tsx");
    expect(reservation).toContain("member-reservation");
    expect(reservation).toContain("<SegmentedTabs");
    expect(reservation).toContain("availability-filter");
    expect(reservation).toContain("formatInstructorNames");
    expect(reservation).toContain("passList");
    expect(reservation).toContain("confirmClass.allowGoods");
    expect(reservation).toContain('cls.classFormat === "private"');
    expect(reservation).toContain("hasStarted");
  });

  it("groups reservation history while retaining profile, type and holiday context", () => {
    const history = read("app/my-reservations/page.tsx");
    expect(history).toContain("member-my-reservations");
    expect(history).toContain("reservation-date-group");
    expect(history).toContain("memberFacingBadge");
    expect(history).toContain("HOLIDAY");
    expect(history).toContain('href="/mypage/calendar"');
  });

  it("keeps selection, controls and history layout in the tokenized style layer", () => {
    const css = read("app/globals.css");
    expect(css).toContain("Batch 4 — reservation and reservation history");
    expect(css).toContain(".member-reservation .cal-cell.selected .daynum-wrap");
    expect(css).toContain(".reservation-list-controls");
    expect(css).toContain(".member-my-reservations .reservation-history .hist-item");
  });
});

describe("Batch 5 center and commerce design contract", () => {
  it("applies the new center shell without replacing current media and review behavior", () => {
    const center = read("app/center/[id]/page.tsx");
    expect(center).toContain("center-detail-v2");
    expect(center).toContain("center-detail-head");
    expect(center).toContain("<ZoomableImage");
    expect(center).toContain("globalThis.appConfirm");
    expect(center).toContain("reservationReturnUrl");
  });

  it("uses commerce layouts while retaining coupon, point and automatic booking logic", () => {
    const cart = read("app/cart/page.tsx");
    const checkout = read("app/checkout/page.tsx");
    expect(cart).toContain("commerce-page cart-page-v2");
    expect(cart).toContain("handleCheckoutAll");
    expect(cart).toContain("applyCoupon");
    expect(checkout).toContain("commerce-page checkout-page-v2");
    expect(checkout).toContain("autoBook");
    expect(checkout).toContain("usePoint");
    expect(checkout).toContain("applyCoupon");
  });

  it("uses shared purchase controls and the tokenized Batch 5 style layer", () => {
    const purchases = read("app/purchases/page.tsx");
    const css = read("app/globals.css");
    expect(purchases).toContain("purchase-page-v2");
    expect(purchases).toContain("<DatePicker");
    expect(purchases).toContain("<ConfirmDialog");
    expect(purchases).toContain("requestRefund");
    expect(css).toContain("Batch 5 — center detail and commerce");
    expect(css).toContain(".center-detail-v2 .center-bottom-bar");
    expect(css).toContain(".commerce-page .checkout-pay-btn");
  });
});

describe("Batch 6 communication and account design contract", () => {
  it("styles member communication screens without removing notification and inquiry deep links", () => {
    const notifications = read("app/notifications/page.tsx");
    const inquiries = read("app/inquiries/page.tsx");
    expect(notifications).toContain("member-notifications");
    expect(notifications).toContain("notificationHref");
    expect(notifications).toContain("<ZoomableImage");
    expect(inquiries).toContain("member-inquiries");
    expect(inquiries).toContain('searchParams.get("thread")');
    expect(inquiries).toContain("<InquiryChat");
  });

  it("keeps current account and authentication behavior inside the new shells", () => {
    const login = read("app/login/page.tsx");
    const mypage = read("app/mypage/page.tsx");
    expect(login).toContain("auth-page-v2");
    expect(login).toContain("REMEMBER_ME_KEY");
    expect(login).toContain("SIGNUP_SUCCESS_MESSAGE");
    expect(login).toContain('handleSocial("google")');
    expect(mypage).toContain("mypage-shell");
    expect(mypage).toContain('href="/settings/account"');
    expect(mypage).toContain('href="/mypage/register-center"');
    expect(mypage).toContain("globalThis.appConfirm");
  });

  it("provides tokenized Batch 6 styling for auth and settings surfaces", () => {
    const css = read("app/globals.css");
    expect(css).toContain("Batch 6: member communication, account and authentication surfaces");
    expect(css).toContain(".auth-scene");
    expect(css).toContain(".member-notifications .noti-row");
    expect(css).toContain(".account-page-v2 .profile-list");
  });
});

describe("Batch 7A manager primary surface contract", () => {
  it("adds the manager overview while retaining current sales and permission behavior", () => {
    const manager = read("app/manager/page.tsx");
    expect(manager).toContain("manager-home-v2");
    expect(manager).toContain("manager-today-overview");
    expect(manager).toContain("fetchDashboardSummary");
    expect(manager).toContain("canSeeManagerMenu");
    expect(manager).toContain("globalThis.appConfirm");
  });

  it("styles member and notification surfaces without replacing current detail and deep-link logic", () => {
    const members = read("app/manager/members/page.tsx");
    const notifications = read("app/manager/notifications/page.tsx");
    expect(members).toContain("manager-members-v2");
    expect(members).toContain("fetchMemberDetail");
    expect(members).toContain('searchParams.get("profile")');
    expect(notifications).toContain("manager-notifications-v2");
    expect(notifications).toContain("notificationHref");
  });

  it("keeps manager classes isolated and provides the Batch 7A style layer", () => {
    const css = read("app/globals.css");
    expect(css).toContain("Batch 7A: manager home, members, notifications and more");
    expect(css).toContain(".manager-today-overview");
    expect(css).toContain(".manager-notifications-v2 .noti-row");
    expect(read("app/manager/classes/page.tsx")).not.toContain("Batch 7A");
  });
});

describe("Batch 7B manager classes design contract", () => {
  it("migrates only the manager class surface while retaining latest scheduling capabilities", () => {
    const classes = read("app/manager/classes/page.tsx");
    expect(classes).toContain("manager-classes-v2");
    expect(classes).toContain("manager-cal-header");
    expect(classes).toContain('aria-label="센터 선택"');
    expect(classes).toContain('type="date"');
    expect(classes).toContain("<AmPmTimeInput");
    expect(classes).toContain("fetchClassTrainers");
    expect(classes).toContain("setClassTrainersBulk");
    expect(classes).toContain("setClassTrainersForGroup");
    expect(classes).toContain("fetchClassPassSelectionMode");
    expect(classes).toContain("updateClassPassSelectionMode");
    expect(classes).toContain("schedule-rule-warning");
    expect(classes).toContain("schedule-rule-override-note");
    expect(classes).toContain("isValidClassTimeRange");
  });

  it("keeps calendar selector contracts and provides the isolated Batch 7B style layer", () => {
    const classes = read("app/manager/classes/page.tsx");
    const css = read("app/globals.css");
    expect(classes).toContain('className="cal-month-nav"');
    expect(classes).toContain('className="cal-nav-btn"');
    expect(classes).toContain('className="cal-title"');
    expect(css).toContain("Batch 7B: manager classes");
    expect(css).toContain(".manager-classes-v2 .manager-cal-header");
    expect(css).toContain(".manager-classes-v2 .manager-holiday-notice");
    expect(css).toContain('.manager-classes-v2 .sheet input[type="date"]');
    expect(css).toMatch(/\.manager-classes-v2>\.fab-btn\{[^}]*bottom:104px/);
  });
});

describe("Batch 7C manager detail surface contract", () => {
  const detailPages = [
    "admin-assignments", "announcements", "center-info", "goods", "holidays", "inquiries",
    "membership-rules", "orders", "progress", "reviews", "rooms", "sales", "settings", "staff",
  ];

  it("keeps every current manager detail feature page in the shared manager shell", () => {
    for (const page of detailPages) {
      expect(read(`app/manager/${page}/page.tsx`), page).toContain("app-shell");
    }
    expect(read("app/manager/progress/record/page.tsx")).toContain("app-shell");
    expect(read("app/manager/staff/permissions/page.tsx")).toContain("app-shell");
  });

  it("provides a shared hierarchy for manager lists, settings, sheets and reports", () => {
    const css = read("app/globals.css");
    expect(css).toContain("Batch 7C: manager detail surfaces");
    expect(css).toContain(".manager-v3-content .center-switcher");
    expect(css).toContain(".manager-v3-content .pass-list");
    expect(css).toContain(".manager-v3-content .settings-wrap");
    expect(css).toContain(".manager-v3-content .sheet:before");
    expect(css).toContain(".manager-v3-content .sales-summary");
  });

  it("retains current manager data operations instead of restoring reference logic", () => {
    expect(read("app/manager/membership-rules/page.tsx")).toContain("fetchProducts");
    expect(read("app/manager/sales/page.tsx")).toContain("fetchPayments");
    expect(read("app/manager/sales/page.tsx")).toContain("summarize");
    expect(read("app/manager/staff/page.tsx")).toContain("fetchStaff");
    expect(read("app/manager/settings/page.tsx")).toContain("fetchSettings");
  });
});
