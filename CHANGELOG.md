# Changelog

## Unreleased

- `DriveHop.exe` now has the DriveHop icon and version info (name shown in Explorer, the taskbar and SmartScreen).
- Footer links in the app: star on GitHub, support the project, report a bug.
- Brand kit in `docs/brand/`: app icon (PNG and ICO), wordmarks, 1280×640 social preview.
- README: "Support DriveHop" section, with donate buttons ready to switch on.

## v0.2.0 (2026-11-21)

- **English UI.** The app is now in English and Vietnamese: it follows your browser language, and an EN | VI switch sits in the header. Messages from the local server are in English.
- **New look.** Inter font (bundled, works offline), brand colors, softer cards, gradient storage bars, cleaner dark mode, a logo and favicon.
- Long email addresses no longer wrap mid-word on account cards.
- New English demo GIF, video and screenshots.

## v0.1.0 (2026-11-21)

First public release.

- One-click Windows app (`DriveHop.exe`): no Node needed, opens the UI in your browser.
- In-app first-run setup for your own Google OAuth client.
- Copy and move files and folders between Google Drive accounts, server-side.
- Resumable, retryable, verified background jobs; optional "Free up space" step.
- Cloudflare Worker mode for jobs that run with the browser closed.
