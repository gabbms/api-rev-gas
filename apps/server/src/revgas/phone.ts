/**
 * Normalizes a Brazilian phone to DDD + number (10 or 11 digits), as accepted by
 * RevGás `GET /customers?phone=`. Strips formatting and the country code 55.
 * Only strips "55" when the number is long enough to carry it (12–13 digits),
 * so DDD 55 (RS) numbers stay intact.
 */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  return digits.length === 10 || digits.length === 11 ? digits : null;
}
