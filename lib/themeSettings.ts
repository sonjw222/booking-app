export type Theme = "system" | "burgundy" | "charcoal";
export type PreviewMode = "light" | "dark";

export function resolveThemePreviewMode(id: Theme, systemDark: boolean): PreviewMode {
  if (id === "system") return systemDark ? "dark" : "light";
  return id === "charcoal" ? "dark" : "light";
}

export function isThemeOptionSelected(current: Theme, optionId: Theme): boolean {
  return current === optionId;
}
