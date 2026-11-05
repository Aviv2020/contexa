// noble-crypto needs crypto.getRandomValues; React Native provides it through expo-crypto (CSPRNG).
import * as ExpoCrypto from 'expo-crypto';

const g = globalThis as unknown as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(a: T) => T } };
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => ExpoCrypto.getRandomValues(array as never) as T;
}
