# Sports icon rendering polish

- Branch: `design/sports-icon-polish-20260927`
- Base: `f8c2c21f19014230a3275ff80337e1867bd70630` (`origin/main`)
- Existing eight 160 × 160 PNG files remain byte-for-byte unchanged. No illustration, pose, object, path, native file or business logic was replaced.
- Shared `CategoryIcon` renders the original bitmap through an SVG luminance/alpha filter. This is **not vector conversion or resolution recovery**. The filter removes the baked pale background, retains source transparency and antialiasing, and applies the existing theme ink token. A vector circle provides consistent surface/border rendering. No stroke dilation or new line geometry is introduced.
- Home, category administration and login artwork use the shared renderer. Login CSS changes only extend existing image sizing selectors to SVG. No grid, gap, navigation, banner or page spacing rules change.

## Optical adjustments

Coordinates use the original 160px canvas; negative y moves the artwork upward. The circular surface does not move or scale.

| Category | Scale | x | y |
|---|---:|---:|---:|
| 피겨스케이팅 | 1.04 | 0 | -10 |
| 필라테스 | 1.06 | 0 | -10 |
| 발레 | 1.08 | 0 | -2 |
| 리듬체조 | 1.00 | -2 | -7 |
| 요가 | 1.08 | 0 | -5 |
| 복싱 | 1.03 | 0 | 0 |
| 수영 | 1.02 | 0 | -6 |
| 골프 | 0.96 | -2 | -3 |

## Verification

- Baseline unit suite: 71 files / 529 tests passed. Final: 72 files / 531 tests passed, including duplicate SVG ID/reference safety and failed-image fallback/category changes.
- `npm run build`: passed with non-production placeholder Supabase environment values. Initial invocation without environment variables failed with `supabaseUrl is required`.
- Chromium production build, mocked Supabase responses, DPR 3: light and dark at 390×844, 430×932, 820×1180, 1180×820 and 1360×900. No horizontal overflow. Icon/grid/item/header bounding rectangles match the original image rendering after swapping the old PNG elements back into the same page.
- Mobile light/dark and tablet light/dark screenshots inspected. Original bitmap detail remains limited by 160px sources, especially at 68 CSS px on DPR 3 displays; no higher-resolution source was available in the repository.
- Existing tablet sidebar overlap also reproduces with the original image elements. Left outside this icon-only change; this is not a full-layout QA pass.
- Real iPhone/iPad/Android, Safari, Firefox, authenticated production flows and Vercel Preview visual inspection remain unverified.
- Future full illustration system is recorded separately in `docs/TODO.md`.
