import crypto from 'node:crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96-bit IV recommended for AES-GCM
const AUTH_TAG_LENGTH_BYTES = 16; // 128-bit authentication tag
const VERSION_PREFIX = 'v1:';

const HEX_REGEX = /^[0-9a-fA-F]+$/;

let cachedKey: Buffer | null = null;
let cachedSecret: string | null = null;

/**
 * Derives a 256-bit key from configuration secrets using SHA-256.
 * Caches the derived key buffer to optimize repeated cryptographic operations.
 */
function getEncryptionKey(): Buffer {
  const secret = env.calendarEncryptionSecret || env.jwtSecret || 'purrific-default-fallback-key-32b';
  if (cachedKey && cachedSecret === secret) {
    return cachedKey;
  }
  cachedSecret = secret;
  cachedKey = crypto.createHash('sha256').update(secret).digest();
  return cachedKey;
}

/**
 * Checks whether a given token matches the encrypted format:
 * `v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 */
export function isEncryptedToken(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') {
    return false;
  }
  if (!token.startsWith(VERSION_PREFIX)) {
    return false;
  }

  const parts = token.split(':');
  if (parts.length !== 4) {
    return false;
  }

  const [version, ivHex, tagHex, cipherHex] = parts;
  if (version !== 'v1') {
    return false;
  }
  if (ivHex.length !== IV_LENGTH_BYTES * 2 || !HEX_REGEX.test(ivHex)) {
    return false;
  }
  if (tagHex.length !== AUTH_TAG_LENGTH_BYTES * 2 || !HEX_REGEX.test(tagHex)) {
    return false;
  }
  if (cipherHex.length > 0 && !HEX_REGEX.test(cipherHex)) {
    return false;
  }

  return true;
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Produces ciphertext in format `v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`.
 */
export function encryptToken(plainText: string): string {
  if (typeof plainText !== 'string') {
    return plainText as unknown as string;
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let cipherHex = cipher.update(plainText, 'utf8', 'hex');
  cipherHex += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${VERSION_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${cipherHex}`;
}

/**
 * Decrypts an AES-256-GCM encrypted token.
 * If the input is nullish or falsy, returns `cipherText ?? ''`.
 * If the input does not start with `v1:`, it is treated as a legacy plaintext
 * token and returned as-is (transparent fallback).
 * Throws an error if the token has the `v1:` prefix but is malformed or corrupted.
 */
export function decryptToken(cipherText: string | null | undefined): string {
  if (!cipherText || typeof cipherText !== 'string' || !cipherText.startsWith(VERSION_PREFIX)) {
    return cipherText ?? '';
  }

  const parts = cipherText.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted token format: expected v1:<iv>:<tag>:<ciphertext>');
  }

  const [version, ivHex, tagHex, cipherHex] = parts;
  if (version !== 'v1' || ivHex.length !== IV_LENGTH_BYTES * 2 || tagHex.length !== AUTH_TAG_LENGTH_BYTES * 2) {
    throw new Error('Invalid encrypted token format: invalid component lengths');
  }

  if (!HEX_REGEX.test(ivHex) || !HEX_REGEX.test(tagHex) || (cipherHex.length > 0 && !HEX_REGEX.test(cipherHex))) {
    throw new Error('Invalid encrypted token format: components must be valid hex');
  }

  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    throw new Error(`Failed to decrypt token: ${(error as Error).message}`);
  }
}
