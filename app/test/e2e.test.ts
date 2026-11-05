import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as e2e from '../src/crypto/e2e.ts';

test('wrap / unwrap a group key for a device', () => {
  const device = e2e.generateKeyPair();
  const groupKey = e2e.generateSymmetricKey();
  const wrapped = e2e.wrapKey(device.publicKey, groupKey);
  assert.deepEqual(e2e.unwrapKey(device.privateKey, wrapped), groupKey);
  const other = e2e.generateKeyPair();
  assert.throws(() => e2e.unwrapKey(other.privateKey, wrapped));
});

test('messages are bound to group and key version', () => {
  const k = e2e.generateSymmetricKey();
  const ct = e2e.encryptPayload(k, 'g1', 1, { text: 'שלום' });
  assert.deepEqual(e2e.decryptPayload(k, 'g1', 1, ct), { text: 'שלום' });
  assert.throws(() => e2e.decryptPayload(k, 'g2', 1, ct));
  assert.throws(() => e2e.decryptPayload(k, 'g1', 2, ct));
});

test('file bytes round-trip and are tamper-evident', () => {
  const k = e2e.generateSymmetricKey();
  const data = new Uint8Array(100_000).map((_, i) => i % 251);
  const enc = e2e.encryptBytes(k, data);
  assert.deepEqual(e2e.decryptBytes(k, enc), data);
  enc[50] ^= 1;
  assert.throws(() => e2e.decryptBytes(k, enc));
});

test('recovery key formatting round-trips and unwraps', () => {
  const rec = e2e.generateKeyPair();
  const text = e2e.formatRecoveryKey(rec.privateKey);
  assert.match(text, /^([0-9A-F]{8}-){7}[0-9A-F]{8}$/);
  const k = e2e.generateSymmetricKey();
  const wrapped = e2e.wrapKey(rec.publicKey, k);
  assert.deepEqual(e2e.unwrapKey(e2e.parseRecoveryKey(text), wrapped), k);
});

test('base64 handles large buffers', () => {
  const big = new Uint8Array(300_000).map((_, i) => i & 0xff);
  assert.deepEqual(e2e.fromB64(e2e.toB64(big)), big);
});
