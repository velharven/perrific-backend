import { randomBytes } from 'crypto';

// Alfabet tanpa karakter ambigu (I, O, 0, 1) agar mudah didikte/di ketik.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomInviteCode(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
