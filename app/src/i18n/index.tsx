import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { I18nManager } from 'react-native';
import * as Localization from 'expo-localization';
import { he, en, type Strings } from './strings';

export type Locale = 'he' | 'en';
type StringKey = { [K in keyof Strings]: Strings[K] extends string ? K : never }[keyof Strings];

export function fmt(s: string, vars: Record<string, string | number> = {}): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

interface I18nCtx {
  locale: Locale;
  rtl: boolean;
  s: Strings;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
  setLocale: (l: Locale) => void;
}

const Ctx = createContext<I18nCtx | null>(null);

export function initialLocale(): Locale {
  return Localization.getLocales()[0]?.languageCode === 'en' ? 'en' : 'he';
}

export function I18nProvider({ children, initial }: { children: React.ReactNode; initial?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initial ?? initialLocale());
  const s = locale === 'he' ? he : en;
  const rtl = locale === 'he';
  if (I18nManager.isRTL !== rtl) {
    I18nManager.allowRTL(rtl);
    I18nManager.forceRTL(rtl); // takes full effect after reload
  }
  const t = useCallback((key: StringKey, vars?: Record<string, string | number>) => fmt(s[key] as string, vars), [s]);
  const value = useMemo(() => ({ locale, rtl, s, t, setLocale: setLocaleState }), [locale, rtl, s, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('I18nProvider missing');
  return c;
}

export function formatTime(ts: number, locale: Locale): string {
  return new Date(ts).toLocaleTimeString(locale === 'he' ? 'he-IL' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(ts: number, locale: Locale, s: Strings): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return s.today;
  if (d.toDateString() === y.toDateString()) return s.yesterday;
  return d.toLocaleDateString(locale === 'he' ? 'he-IL' : 'en-GB', { day: '2-digit', month: '2-digit', year: Date.now() - ts > 300 * 86400000 ? '2-digit' : undefined });
}

export function formatListTime(ts: number, locale: Locale, s: Strings): string {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return formatTime(ts, locale);
  return formatDay(ts, locale, s);
}
