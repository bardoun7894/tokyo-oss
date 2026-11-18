// Read a money amount out of a chat message.
//
// The payment pipeline used to log every payment as 0 and ask the owner to
// "update the amount when confirmed", which never happened: every income row
// ever written is 0. If the message says the amount, use it; if it does not,
// the caller must ask rather than write a zero.

export interface ParsedAmount {
  amount: number;
  currency: string;
}

const CURRENCIES: [RegExp, string][] = [
  [/\b(dh|dhs|mad|درهم|درهما|dirhams?)\b/i, "DH"],
  [/[$]|\b(usd|dollars?|دولار)\b/i, "USD"],
  [/[€]|\b(eur|euros?|أورو|يورو)\b/i, "EUR"],
];

/** Digits with optional thousands separators: 17 500 / 17,500 / 17.500 / 1500.50 */
const NUMBER = /(\d{1,3}(?:[  ,.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g;

function toNumber(raw: string): number | null {
  let s = raw.replace(/[  ]/g, "");
  // 17.500 and 17,500 are thousands here; 1500.50 and 1500,50 are decimals.
  if (/[.,]\d{3}(?:\D|$)/.test(s) && !/[.,]\d{1,2}$/.test(s)) s = s.replace(/[.,]/g, "");
  else s = s.replace(/,(\d{1,2})$/, ".$1").replace(/(?<=\d),(?=\d{3})/g, "");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The amount a message states, or null when it states none. Deliberately strict:
 * a wrong number in a money record is worse than no record at all.
 */
export function parseAmount(text: string, defaultCurrency = "DH"): ParsedAmount | null {
  if (!text) return null;
  // Not an amount: phone numbers, dates, times, order counts.
  const cleaned = text
    .replace(/\b0\d[\d  .-]{7,}\b/g, " ")            // phone numbers
    .replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, " ") // dates
    .replace(/\b\d{1,2}:\d{2}\b/g, " ");             // times

  const matches = cleaned.match(NUMBER);
  if (!matches) return null;

  const numbers = matches.map(toNumber).filter((n): n is number => n !== null);
  if (numbers.length === 0) return null;

  let currency = defaultCurrency;
  for (const [re, code] of CURRENCIES) {
    if (re.test(cleaned)) { currency = code; break; }
  }

  // Several numbers in one message is ambiguous ("3 items, 200 dh each"), so
  // take the largest only when a currency was named; otherwise give up.
  if (numbers.length > 1 && currency === defaultCurrency && !CURRENCIES.some(([re]) => re.test(cleaned))) {
    return null;
  }
  return { amount: Math.max(...numbers), currency };
}
