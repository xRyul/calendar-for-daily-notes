import type { ILocaleOverride, IWeekStartOption } from "obsidian-calendar-ui";

type WeekSpec = {
  dow: number;
  doy?: number;
};

type MomentLocaleDataWithWeek = {
  _week?: WeekSpec;
};

declare global {
  interface Window {
    _bundledLocaleWeekSpec: WeekSpec;
  }
}

const langToMomentLocale: Record<string, string> = {
  en: "en-gb",
  zh: "zh-cn",
  "zh-tw": "zh-tw",
  ru: "ru",
  ko: "ko",
  it: "it",
  id: "id",
  ro: "ro",
  "pt-br": "pt-br",
  cz: "cs",
  da: "da",
  de: "de",
  es: "es",
  fr: "fr",
  no: "nn",
  pl: "pl",
  pt: "pt",
  tr: "tr",
  hi: "hi",
  nl: "nl",
  ar: "ar",
  ja: "ja",
};

const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];


function overrideGlobalMomentWeekStart(weekStart: IWeekStartOption): void {
  const { moment } = window;
  const currentLocale = moment.locale();

  // Save the initial locale weekspec so that toggling between settings can restore it.
  if (!window._bundledLocaleWeekSpec) {
    const localeData = moment.localeData() as unknown as MomentLocaleDataWithWeek;
    window._bundledLocaleWeekSpec = localeData._week ?? { dow: 0, doy: 6 };
  }

  if (weekStart === "locale") {
    moment.updateLocale(currentLocale, {
      week: window._bundledLocaleWeekSpec,
    });
    return;
  }

  moment.updateLocale(currentLocale, {
    week: {
      dow: weekdays.indexOf(weekStart) || 0,
    },
  });
}

export function configureCalendarMomentLocale(
  localeOverride: ILocaleOverride = "system-default",
  weekStart: IWeekStartOption = "locale"
): string {
  const systemLang = navigator.language?.toLowerCase() || "en";
  const baseLang = systemLang.split("-")[0];

  let momentLocale =
    langToMomentLocale[systemLang] ??
    langToMomentLocale[baseLang] ??
    systemLang;

  if (localeOverride !== "system-default") {
    momentLocale = localeOverride;
  }

  const currentLocale = window.moment.locale(momentLocale);
  console.debug(
    `[Calendar] Trying to switch Moment.js global locale to ${momentLocale}, got ${currentLocale}`
  );

  overrideGlobalMomentWeekStart(weekStart);

  return currentLocale;
}
