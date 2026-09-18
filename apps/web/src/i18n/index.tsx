import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { storage } from '../lib/storage';
import { contentRu, genericRu } from './content.ru';
import { en, ru, type UiKey } from './ui';

export type Lang = 'ru' | 'en';
const LANG_KEY = 'funnel:lang';

/** ?lang= wins, then the saved choice, then the browser language. */
function initialLang(): Lang {
  const fromUrl = new URLSearchParams(window.location.search).get('lang');
  if (fromUrl === 'ru' || fromUrl === 'en') return fromUrl;
  const saved = storage.getJson<Lang>(LANG_KEY);
  if (saved === 'ru' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Interface string with {placeholders}. */
  t: (key: UiKey, vars?: Record<string, string | number>) => string;
  /** Plural form ("one" | "few" | "many" | "other") for a number in the current language (Intl.PluralRules). */
  plural: (n: number) => 'one' | 'few' | 'many' | 'other';
  /** Funnel content from a config: translated when a translation exists, otherwise shown as is. */
  tc: (text: string | undefined) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    storage.setJson(LANG_KEY, next);
    setLangState(next);
  }, []);

  const value = useMemo<I18n>(() => {
    const dict = lang === 'ru' ? ru : en;
    const rules = new Intl.PluralRules(lang);
    return {
      lang,
      setLang,
      plural: (n) => {
        const form = rules.select(n);
        return form === 'one' || form === 'few' || form === 'many' ? form : 'other';
      },
      t: (key, vars) => dict[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`)),
      tc: (text) => {
        if (text === undefined) return '';
        if (lang !== 'ru') return text;
        const exact = Object.hasOwn(contentRu, text) ? contentRu[text] : undefined;
        if (exact) return exact;
        for (const [pattern, render] of genericRu) {
          const m = text.match(pattern);
          if (m) return render(m);
        }
        return text;
      },
    };
  }, [lang, setLang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

export function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <span className="lang" role="group" aria-label={t('lang.switch')}>
      {(['ru', 'en'] as const).map((l) => (
        <button key={l} className={l === lang ? 'on' : ''} onClick={() => setLang(l)} aria-pressed={l === lang}>
          {l.toUpperCase()}
        </button>
      ))}
    </span>
  );
}
