/**
 * A cheap Turkish/English guess for a query or a doc, used as a RANKING feature only (never a gold
 * label): the local hybrid gives the dense channel guaranteed slots when the query and a document
 * are in different languages, because BM25 cannot match across them at all.
 *
 * Signals: Turkish-only letters (ç ğ ı ö ş ü İ), plus function words of each language. An ASCII-typed
 * Turkish query ("nasil calisiyor") has no special letters, so the function words carry it. Returns
 * 'mixed' when both languages show real weight, 'unknown' when neither does (a slug, a code token).
 */
export type TextLang = 'tr' | 'en' | 'mixed' | 'unknown';

const TR_LETTERS = /[çğışöü]/;

// No word that is also common English (`her`, `once`, `var`): those would tip an English query to Turkish.
const TR_WORDS = new Set([
  've', 'veya', 'ile', 'bir', 'bu', 'şu', 'ne', 'ki', 'de', 'da', 'mı', 'mi', 'mu', 'mü', 'için', 'icin',
  'gibi', 'ama', 'nasıl', 'nasil', 'neden', 'hangi', 'hangisi', 'nerede', 'olan', 'olarak', 'bunu', 'çok',
  'cok', 'daha', 'sonra', 'önce', 'yok', 'değil', 'degil', 'şey', 'sey', 'kadar', 'diye',
  'zaman', 'neyi', 'nedir', 'oldu', 'olur', 'mıydı', 'miydi', 'muydu', 'idi', 'iken', 'artık', 'artik',
  'hep', 'tüm', 'tum', 'bütün', 'butun', 'ise', 'yani', 'şimdi', 'simdi', 'hala', 'hâlâ', 'niye',
]);

const EN_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
  'by', 'from', 'that', 'this', 'it', 'and', 'or', 'but', 'not', 'do', 'does', 'did', 'have', 'has', 'had',
  'will', 'would', 'could', 'should', 'can', 'what', 'why', 'how', 'when', 'where', 'which', 'who', 'we',
  'they', 'our', 'their', 'there', 'about', 'into', 'after', 'before', 'never', 'every', 'still', 'than',
]);

/** Guess the language of `text` (at most the first `maxChars` characters are read). */
export function detectTextLang(text: string, maxChars = 2000): TextLang {
  const sample = text.slice(0, maxChars);
  // Plain lowercase, not the Turkish locale: that would turn an English "If" into "ıf".
  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length === 0) return 'unknown';
  let tr = 0;
  let en = 0;
  for (const w of words) {
    if (TR_WORDS.has(w)) tr++;
    else if (EN_WORDS.has(w)) en++;
  }
  // Every Turkish-only letter is strong evidence; a word containing one counts once.
  tr += words.filter((w) => TR_LETTERS.test(w)).length;
  if (tr === 0 && en === 0) return 'unknown';
  const total = tr + en;
  if (tr / total >= 0.75) return 'tr';
  if (en / total >= 0.75) return 'en';
  return 'mixed';
}
