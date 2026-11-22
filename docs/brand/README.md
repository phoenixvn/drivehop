# DriveHop brand kit

| File | Use |
|---|---|
| [`../logo.svg`](../logo.svg) | Master logo (vector). Favicon and in-app logo are copies of it. |
| `icon-32.png`, `icon-128.png`, `icon-256.png`, `icon-512.png` | App icon as PNG, transparent background (avatars, store listings, posts). |
| `drivehop.ico` | Windows icon (16 to 256 px). Embedded in `DriveHop.exe` by `npm run build:desktop`. |
| `wordmark-light.png` | Logo plus name for light backgrounds. |
| `wordmark-dark.png` | Logo plus name for dark backgrounds. |
| `social-preview.png` | 1280×640 card for the GitHub social preview and link previews (Reddit, X, Facebook, Discord). |

## Colors and type

| Token | Value |
|---|---|
| Brand gradient | `#2563eb` → `#7c3aed` (top-left to bottom-right) |
| Ink | `#0f172a` |
| Dark background | `#0b1020` |
| Font | Inter (variable), weights 600 to 800 for headings |

Keep clear space around the logo of at least a quarter of its width. Don't recolor, stretch or add effects to the mark.

The screenshots in `../media/` and in `social-preview.png` come from demo mode (`?mock=1&demo=1`), so none of the accounts or files in them are real.

## Turning on donations

The donate buttons are ready in both READMEs, commented out until the accounts exist.

1. **GitHub Sponsors** (0% fee, available in Vietnam): <https://github.com/sponsors/accounts> → *Join the waitlist* for `phoenixvn`, fill in the profile, payout (bank account via Stripe) and tax form. Approval usually takes a few days.
2. **Ko-fi** (0% fee on one-off donations, payouts via PayPal or Stripe): sign up at <https://ko-fi.com>, pick a page name, connect PayPal.
3. Then:
   - in `.github/FUNDING.yml`, uncomment `github:` and `ko_fi:` (this adds the **Sponsor** button on the repo page);
   - in `README.md` and `README.vi.md`, replace `KOFI_NAME` and delete the `<!-- DONATE` and `END DONATE -->` lines;
   - drop any button whose account you didn't create.

The in-app footer link (*Support DriveHop*) points at the README's [Support section](../../README.md#support-drivehop), so it never needs to change.
