/**
 * Tiny i18n layer: English (default for the world) and Vietnamese.
 *
 * The language is chosen once at startup:
 *   1. `?lang=en|vi` in the URL (also saved, so links and the demo recorder can force it)
 *   2. the choice saved by the header toggle (localStorage)
 *   3. the browser language (`vi*` -> Vietnamese, anything else -> English)
 * Switching saves the choice and reloads the page, so module-level label tables stay simple.
 *
 * Strings live next to the code that uses them:
 *   const S = strings({ en: { title: 'Hello', count: (n: number) => `${n} files` }, vi: { ... } });
 * The `vi` object must have exactly the shape of `en`, so a missing translation fails typecheck.
 */

export const LANGS = ['en', 'vi'] as const;
export type Lang = (typeof LANGS)[number];

const STORAGE_KEY = 'drivehop.lang';

function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(lang: Lang): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Private mode or blocked storage: the choice just won't be remembered.
  }
}

function detectLang(): Lang {
  if (typeof window === 'undefined') return 'en';
  const fromUrl = new URLSearchParams(window.location.search).get('lang');
  if (isLang(fromUrl)) {
    store(fromUrl);
    return fromUrl;
  }
  const saved = readStored();
  if (isLang(saved)) return saved;
  const browser = typeof navigator === 'undefined' ? '' : (navigator.language ?? '');
  return browser.toLowerCase().startsWith('vi') ? 'vi' : 'en';
}

export const lang: Lang = detectLang();

/** BCP 47 locale for Intl formatting and collation. */
export const locale = lang === 'vi' ? 'vi-VN' : 'en-US';

if (typeof document !== 'undefined') document.documentElement.lang = lang;

/** Picks this language's strings. `vi` must match the shape of `en`. */
export function strings<T>(table: { en: T; vi: NoInfer<T> }): T {
  return table[lang];
}

/** Saves the language and reloads so every label is rebuilt. Drops `?lang=` from the URL. */
export function switchLang(next: Lang): void {
  if (next === lang) return;
  store(next);
  const url = new URL(window.location.href);
  url.searchParams.delete('lang');
  window.location.replace(url.toString());
}
