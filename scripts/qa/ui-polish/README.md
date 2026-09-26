# UI polish fixture QA

These runners start the production Next server themselves, use synthetic Supabase responses, and never validate live transactions. Run from the repository root. They do not call real OAuth, payment, messaging, geolocation, or native APIs. Unexpected external HTTP requests are blocked.

```sh
NEXT_PUBLIC_SUPABASE_URL=https://qa-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=qa-placeholder npm run build
QA_OUTPUT_DIR=/absolute/path/to/qa-output node scripts/qa/ui-polish/matrix.cjs
QA_OUTPUT_DIR=/absolute/path/to/qa-output node scripts/qa/ui-polish/interactions.cjs
```

Install the Playwright Chromium browser first. Optional `QA_CHROMIUM_EXECUTABLE` selects an existing browser binary; `QA_FONTCONFIG_FILE` selects a Linux fontconfig file with Korean fonts. The September 26 run used Chrome Headless Shell 131.0.6778.204. Screenshots require Korean fonts to assess text properly.

Place official Leaflet 1.9.4 `leaflet.js` and `leaflet.css` in `QA_OUTPUT_DIR` for the map stacking check. Map tiles and marker images are intentionally not fetched; stacking tests inspect the actual Leaflet DOM and hit testing, not geographical accuracy or map tile availability.

- `matrix.cjs`: 32 routes × 10 viewports × 2 themes, overflow/runtime error/CTA overlap checks; screenshots for 390/820/1180/1440 widths.
- `interactions.cjs`: sheets, Tab/Escape/body lock, reduced viewport height, cart clearance, search/navigation, signup step 2, staff permissions, phone-less recipient selection, map header hit testing. No save, purchase, reservation, OTP, or send action is submitted.
- `QA_CHECKS='staff permissions,map stacking'` limits interaction checks.

`burgundy` is the existing application's light-theme storage key; `charcoal` is dark. The brand palette remains navy. Fixture responses intentionally cover only a small representative data set and some empty states; they are not a replacement for live authenticated QA. Full-page screenshots include a fixed navigation bar at the viewport boundary; use scroll/geometry checks to distinguish that expected capture artifact from inaccessible bottom content.

Exit status alone is not a QA pass: inspect `matrix.json` for `overflow`, `errors`, and `ctaOverlap`, and `interactions.json` for `pass:false`.
