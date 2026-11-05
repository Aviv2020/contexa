/**
 * End-to-end encryption primitives (spec §6.5). Pure TypeScript (noble), no platform dependencies,
 * so it can be unit-tested in Node.
 *
 *  - Device key: X25519 key pair. The private key never leaves the device's biometric-protected secure storage.
 *  - Group key: random 256-bit symmetric key, versioned, wrapped per recipient device (ECIES: X25519 + HKDF-SHA256 + AES-256-GCM).
 *  - Messages: AES-256-GCM under the group key, with AAD binding the ciphertext to group + key version.
 *  - Files: per-file random AES-256-GCM key; the file key travels inside the (encrypted) message payload.
 *  - Org recovery key: an X25519 key pair; only the public half is uploaded. Every group key is also wrapped to it.
 */
import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes, utf8ToBytes, bytesToUtf8, concatBytes } from '@noble/hashes/utils';

const WRAP_INFO = utf8ToBytes('contexa-wrap-v1');

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

export function generateSymmetricKey(): Uint8Array {
  return randomBytes(32);
}

/** Wrap a symmetric key for a recipient public key. Output: base64(ephemeralPub[32] | nonce[12] | ciphertext). */
export function wrapKey(recipientPublicKey: Uint8Array, key: Uint8Array): string {
  const eph = generateKeyPair();
  const shared = x25519.getSharedSecret(eph.privateKey, recipientPublicKey);
  const kek = hkdf(sha256, shared, concatBytes(eph.publicKey, recipientPublicKey), WRAP_INFO, 32);
  const nonce = randomBytes(12);
  const ct = gcm(kek, nonce).encrypt(key);
  return toB64(concatBytes(eph.publicKey, nonce, ct));
}

export function unwrapKey(privateKey: Uint8Array, wrapped: string): Uint8Array {
  const raw = fromB64(wrapped);
  const ephPub = raw.subarray(0, 32);
  const nonce = raw.subarray(32, 44);
  const ct = raw.subarray(44);
  const shared = x25519.getSharedSecret(privateKey, ephPub);
  const kek = hkdf(sha256, shared, concatBytes(ephPub, publicKeyOf(privateKey)), WRAP_INFO, 32);
  return gcm(kek, nonce).decrypt(ct);
}

function aad(groupId: string, keyVersion: number): Uint8Array {
  return utf8ToBytes(`contexa-msg-v1|${groupId}|${keyVersion}`);
}

/** Encrypt a JSON payload for a group. Output: base64(nonce[12] | ciphertext). */
export function encryptPayload(groupKey: Uint8Array, groupId: string, keyVersion: number, payload: unknown): string {
  const nonce = randomBytes(12);
  const ct = gcm(groupKey, nonce, aad(groupId, keyVersion)).encrypt(utf8ToBytes(JSON.stringify(payload)));
  return toB64(concatBytes(nonce, ct));
}

export function decryptPayload<T = unknown>(groupKey: Uint8Array, groupId: string, keyVersion: number, ciphertext: string): T {
  const raw = fromB64(ciphertext);
  const pt = gcm(groupKey, raw.subarray(0, 12), aad(groupId, keyVersion)).decrypt(raw.subarray(12));
  return JSON.parse(bytesToUtf8(pt)) as T;
}

/** Encrypt file bytes with a per-file key. Output: nonce[12] | ciphertext. */
export function encryptBytes(fileKey: Uint8Array, data: Uint8Array): Uint8Array {
  const nonce = randomBytes(12);
  return concatBytes(nonce, gcm(fileKey, nonce).encrypt(data));
}

export function decryptBytes(fileKey: Uint8Array, data: Uint8Array): Uint8Array {
  return gcm(fileKey, data.subarray(0, 12)).decrypt(data.subarray(12));
}

/** Human-friendly rendering of the recovery private key (shown once to the org owner). */
export function formatRecoveryKey(privateKey: Uint8Array): string {
  const hex = Array.from(privateKey, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{1,8}/g)!.join('-');
}

export function parseRecoveryKey(text: string): Uint8Array {
  const hex = text.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 64) throw new Error('invalid_recovery_key');
  return Uint8Array.from(hex.match(/.{2}/g)!, (h) => parseInt(h, 16));
}

/** Plaintext structure inside an encrypted message. Everything sensitive lives here, including file names (§6.5). */
export interface MessagePayload {
  text?: string;                      // message text or caption
  files?: {
    id: string;
    name: string;
    mime: string;
    size: number;                     // plaintext size of the original
    key: string;                      // base64 file key
    width?: number;
    height?: number;
  }[];
}
