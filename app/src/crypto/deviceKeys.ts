/**
 * Device key storage (§6.5, §4.1). The X25519 private key is kept in the platform secure hardware store
 * (iOS Keychain / Secure Enclave access control, Android Keystore) with `requireAuthentication`, so reading it
 * requires a biometric check, and the item is invalidated when biometrics change (new fingerprint ⇒ re-login via OTP).
 */
import * as SecureStore from 'expo-secure-store';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { fromB64, generateKeyPair, publicKeyOf, toB64 } from './e2e';

const PRIV = 'contexa.device.priv';
const BIO_OPTS: SecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  authenticationPrompt: 'Contexa',
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};

export async function createDeviceKey(): Promise<{ publicKey: string }> {
  const kp = generateKeyPair();
  await SecureStore.setItemAsync(PRIV, toB64(kp.privateKey), BIO_OPTS);
  return { publicKey: toB64(kp.publicKey) };
}

export type UnlockResult = { ok: true; privateKey: Uint8Array } | { ok: false; reason: 'missing' | 'failed' };

/** Triggers the biometric prompt. 'missing' means no key or a key invalidated by a biometric change. */
export async function unlockDeviceKey(): Promise<UnlockResult> {
  try {
    const v = await SecureStore.getItemAsync(PRIV, BIO_OPTS);
    if (!v) return { ok: false, reason: 'missing' };
    return { ok: true, privateKey: fromB64(v) };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/invalidat|not found|no such|KeyPermanentlyInvalidated/i.test(msg)) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'failed' };
  }
}

export async function deleteDeviceKey(): Promise<void> {
  await SecureStore.deleteItemAsync(PRIV, BIO_OPTS).catch(() => undefined);
}

export function devicePublicKey(privateKey: Uint8Array): string {
  return toB64(publicKeyOf(privateKey));
}

/** Per-org SQLCipher key derived from the device key: the local database is only readable after biometric unlock. */
export function localDbKey(privateKey: Uint8Array, orgId: string): string {
  const k = hkdf(sha256, privateKey, utf8ToBytes(orgId), utf8ToBytes('contexa-localdb-v1'), 32);
  return Array.from(k, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Non-secret session values (still stored in the keychain, without biometric gating).
export const plainStore = {
  get: (k: string) => SecureStore.getItemAsync(`contexa.${k}`),
  set: (k: string, v: string) => SecureStore.setItemAsync(`contexa.${k}`, v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  del: (k: string) => SecureStore.deleteItemAsync(`contexa.${k}`),
};
