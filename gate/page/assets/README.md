# Brand marks inlined into the sign-in page

- `instacloud-wordmark.svg`: InsForge/instacloud-console `public/instacloud-logo.svg`, byte for byte (identical to the landing site's `public/brand/instacloud-wordmark.svg`). Shown in light mode.
- `instacloud-wordmark-inverse.svg`: InsForge/instacloud-landing `public/brand/instacloud-wordmark-inverse.svg`, byte for byte. Shown in dark mode.
- `instacloud-icon.svg` and `instacloud-icon-inverse.svg`: the console's `src/app/icon.svg` split into its own light and dark rules (`.f` black and `.c` white, then `.f` white and `.c` none), with the `<style>` block removed so two copies can sit in one page. Path data unchanged.
