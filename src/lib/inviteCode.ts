import { randomBytes } from 'crypto';
import { encryptToken, decryptToken, isEncryptedToken } from './crypto';

// Alfabet tanpa karakter ambigu (I, O, 0, 1) agar mudah didikte/di ketik.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomInviteCode(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * Enkripsi kode invite ke token URL-safe (base64url) menggunakan AES-256-GCM
 */
export function encryptInviteCode(code: string): string {
  if (!code || typeof code !== 'string') return '';
  const encrypted = encryptToken(code);
  return Buffer.from(encrypted, 'utf8').toString('base64url');
}

/**
 * Dekripsi token invite.
 * Jika input merupakan token terenkripsi, kembalikan kode invite aslinya.
 * Jika input bukan token terenkripsi (misal kode pendek manual 'ABC123XYZ'), kembalikan apa adanya (fallback transparan).
 */
export function decryptInviteCode(tokenOrCode: string): string {
  if (!tokenOrCode || typeof tokenOrCode !== 'string') return '';
  try {
    const raw = Buffer.from(tokenOrCode, 'base64url').toString('utf8');
    if (isEncryptedToken(raw)) {
      return decryptToken(raw);
    }
  } catch {
    // Abaikan error decoding base64url dan fallback ke input asli
  }
  return tokenOrCode;
}
