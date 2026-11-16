/** Normalise Kenyan mobile numbers to Daraja's 2547XXXXXXXX / 2541XXXXXXXX form. */
export function normalizeMsisdn(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, "").replace(/^\+/, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}

export function maskMsisdn(msisdn: string | undefined): string | undefined {
  if (!msisdn || msisdn.length < 9) return msisdn;
  return `${msisdn.slice(0, 5)}****${msisdn.slice(-3)}`;
}
