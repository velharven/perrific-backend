import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptToken, encryptToken, isEncryptedToken } from './crypto';

test('encryptToken and decryptToken cycle preserves the original plaintext', () => {
  const plainText = 'ya29.a0AfH6SMA...sample-google-oauth-token-12345';
  const encrypted = encryptToken(plainText);
  const decrypted = decryptToken(encrypted);

  assert.equal(decrypted, plainText);
});

test('encryptToken handles unicode and special characters', () => {
  const plainText = 'token-with-unicode-🐱-and-symbols-!@#$%^&*()_+={}|[]:;<>?,./~`';
  const encrypted = encryptToken(plainText);
  const decrypted = decryptToken(encrypted);

  assert.equal(decrypted, plainText);
});

test('encryptToken format starts with v1: and contains 12-byte IV, 16-byte tag, and ciphertext in hex', () => {
  const plainText = 'sample-refresh-token';
  const encrypted = encryptToken(plainText);

  assert.ok(encrypted.startsWith('v1:'));
  const parts = encrypted.split(':');
  assert.equal(parts.length, 4, 'Ciphertext format must be v1:<iv>:<tag>:<ciphertext>');
  assert.equal(parts[0], 'v1');
  assert.equal(parts[1].length, 24, 'IV must be 12 bytes (24 hex chars)');
  assert.equal(parts[2].length, 32, 'Auth tag must be 16 bytes (32 hex chars)');
  assert.ok(parts[3].length > 0, 'Ciphertext payload must not be empty');
  assert.ok(/^[0-9a-f]+$/i.test(parts[1]), 'IV must be valid hex');
  assert.ok(/^[0-9a-f]+$/i.test(parts[2]), 'Auth tag must be valid hex');
  assert.ok(/^[0-9a-f]+$/i.test(parts[3]), 'Ciphertext must be valid hex');
});

test('two encryptions of the same plaintext produce different ciphertexts (random IV)', () => {
  const plainText = 'identical-secret-token';
  const encrypted1 = encryptToken(plainText);
  const encrypted2 = encryptToken(plainText);

  assert.notEqual(encrypted1, encrypted2);
  assert.equal(decryptToken(encrypted1), plainText);
  assert.equal(decryptToken(encrypted2), plainText);
});

test('decryptToken returns legacy plaintext token without v1: prefix unmodified', () => {
  const legacyToken = '1//0gXYZ...legacy-unencrypted-refresh-token';
  const decrypted = decryptToken(legacyToken);

  assert.equal(decrypted, legacyToken);
});

test('decryptToken throws an error when ciphertext or auth tag is corrupted', () => {
  const plainText = 'sensitive-token';
  const encrypted = encryptToken(plainText);
  const parts = encrypted.split(':');

  // Corrupt the ciphertext payload
  const corruptedCipher = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3].slice(0, -2)}ff`;
  assert.throws(() => decryptToken(corruptedCipher), /Unsupported state or unable to authenticate data|bad decrypt|Failed to decrypt/i);

  // Corrupt the auth tag
  const tamperedTag = parts[2].slice(0, -2) + (parts[2].endsWith('00') ? 'ff' : '00');
  const corruptedTag = `${parts[0]}:${parts[1]}:${tamperedTag}:${parts[3]}`;
  assert.throws(() => decryptToken(corruptedTag), /Unsupported state or unable to authenticate data|bad decrypt|Failed to decrypt/i);
});

test('decryptToken throws an error on malformed v1 token structure', () => {
  assert.throws(() => decryptToken('v1:malformed'), /Invalid encrypted token format/i);
  assert.throws(() => decryptToken('v1:invalid_iv:invalid_tag:invalid_cipher'), /Invalid encrypted token format|Unsupported state/i);
});

test('isEncryptedToken correctly identifies encrypted tokens and rejects non-encrypted or malformed strings', () => {
  const plainText = 'my-token';
  const encrypted = encryptToken(plainText);

  assert.equal(isEncryptedToken(encrypted), true);
  assert.equal(isEncryptedToken('ya29.sample-token'), false);
  assert.equal(isEncryptedToken('1//0g-sample-refresh-token'), false);
  assert.equal(isEncryptedToken(''), false);
  assert.equal(isEncryptedToken('v1:short'), false);
  assert.equal(isEncryptedToken('v1:part1:part2:part3:extra'), false);
  assert.equal(isEncryptedToken('v2:123456789012345678901234:12345678901234567890123456789012:abcdef'), false);
});
