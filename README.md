# Contexa

Secure team messaging where every conversation is tied to a context: a patient, client, case or property.
This is an implementation of **Phase A (MVP)** from spec v0.5: standalone organizations, contexts and groups,
end-to-end encrypted chat, saving files to the context archive, notifications, on-device search, in-app
admin screens and an audit log.

```
contexa/
├── server/   Cloudflare Workers API (Hono, D1, Durable Objects, R2, KV, Cron)
├── app/      Mobile app (Expo / React Native, iOS 16+ and Android 11+, Hebrew RTL and English)
└── scripts/  e2e-protocol.ts: an end-to-end protocol check against a running server
```

## Running locally

### Server
```bash
cd server
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev              # http://localhost:8787, OTP_DEV_MODE: the code is returned in the response
npm test                 # 19 integration tests on the Workers runtime (Miniflare)
```

### App
The app needs a **development build**, not Expo Go, because it uses SQLCipher, biometrics, react-native-pdf
and jail-monkey:
```bash
cd app
npm install
EXPO_PUBLIC_API_URL=http://<host>:8787 npx expo run:ios      # or run:android
npm test                 # encryption unit tests
npm run typecheck
```

### End-to-end protocol check
With `npm run dev` running in `server/`:
```bash
node --experimental-strip-types scripts/e2e-protocol.ts http://localhost:8787
```
This runs two real devices with X25519 keys through: group key creation and wrapping, encrypted messages
and files, a new member opening the history, removal and key rotation, and the WebSocket.

## Mapping to the spec

| Section | Implementation |
|---|---|
| 3.1, 3.5 Identity and OTP | `server/src/do/otp.ts`: a Durable Object per phone number, 6-digit CSPRNG code, HMAC-SHA256, 5 minutes, single use, constant-time comparison, bound to the request ID and device, 5 attempts, 60-second resend delay, 3 sends per 15 minutes, IP and device rate limits. SMS via InforU (`lib/inforu.ts`). Every send and verification is audited with a masked number. |
| 3.2–3.4 Roles and membership | admin/user roles, job titles, personal SMS invitations limited to 7 days, deactivation that removes the user from every group and disconnects devices, one account across several orgs, org switcher with unread counts |
| 4.1 Access | Biometrics required. The device's private key sits in the Keychain/Keystore with `requireAuthentication`, so a biometric change invalidates it and forces an OTP re-login. Auto-logout uses the strictest setting across the user's orgs. Local wipe after 5 failed biometric attempts. Admins can remotely disconnect a device. |
| 4.2 Contexts and groups | Manual creation and CSV import, one group per context, members limited to the same org, full history for new members, immediate loss of access on removal, archiving (read-only but still searchable), search, filters, pinning, mute, unread counts |
| 4.3 Chat | Text, reply, @mentions, edit and delete within 15 minutes (audited), delivered and read receipts plus "read by", up to 10 images, 25MB documents, captions, image viewer and in-app PDF preview, download and share blocked by default |
| 4.3.3 Archive | Long-press, then document type, description (encrypted) and date; multiple files in one save; duplicates blocked with the existing save's details; deleting the chat message keeps the archive copy; admin-only removal, audited |
| 4.4 Notifications | Push says only "New message in Contexa"; mute per group; "do not disturb" outside org operating hours; mentions still notify in a muted group |
| 4.5 Search | FTS5 on the device over the decrypted SQLCipher DB, with filters for images, documents, saved to archive, sender and dates, and an "includes messages up to…" banner while history syncs |
| 4.6 Admin | Users, context type, contexts and CSV import, document types, retention, permissions, operating hours, auto-logout, audit log with CSV export, active devices. Plugins show as empty (Phase B). |
| 6.1 Security | Screenshot blocking (FLAG_SECURE, iOS capture protection), screenshot audit on iOS, background privacy cover, root/jailbreak blocking, per-org local wipe |
| 6.5 E2E | `app/src/crypto/e2e.ts`: X25519 device key, a versioned AES-256-GCM group key wrapped per device (ECIES with HKDF), AAD binding each message to its group and key version, a per-file key carried inside the encrypted message, file names encrypted, a recovery key shown once with only its public half sent to the server, forced key rotation on member removal |
| 7.7 Local-first | SQLCipher DB per org, delta sync by revision cursor, one WebSocket per user (DO with Hibernation), an offline outbox with idempotent `clientId`, three image variants made on the device, an encrypted media cache with LRU eviction |
| Retention | Daily cron (`server/src/retention.ts`) deletes messages and files older than the retention period that were not saved to the archive |

## Implementation decisions to review

1. **One D1 for org data, scoped by `org_id`, instead of one D1 per org (§7.2, §7.6).** A Worker cannot create D1
   bindings at runtime, so a DB per org needs per-org provisioning and migration tooling. All org queries go through
   `org_id` and are kept separate from the central DB, so a move to a DB per org, or to SQLite Durable Objects per
   org, is a change to the data-access layer.
2. **Message ordering:** an atomic counter in D1 (`groups.last_seq` plus an org-wide `rev`) instead of a Durable
   Object per group. Durable Objects are used for OTP, rate limiting and the per-user real-time channel. A per-group
   DO for presence and typing indicators can be added later.
3. **Signed blob URLs:** files go through a Worker endpoint with an HMAC token (10 minutes for upload, 5 for
   download) rather than R2 S3 presigning. That avoids holding R2 S3 credentials. The bytes are always ciphertext.
   25MB fits in a single PUT. Files larger than about 100MB would need multipart upload.
4. **Device key:** X25519 in hardware-backed secure storage with biometric access control. Secure Enclave does
   not support X25519 directly, so the key is protected by the Keychain/Keystore rather than generated inside
   the enclave.
5. **Push:** through Expo Push (which relays to APNs/FCM). Switching to APNs/FCM directly is a change to `lib/push.ts` only.
6. **Protocol:** JSON + Brotli (handled automatically by Cloudflare). Protobuf/MessagePack (§7.7) is an optional optimization.

## Before production

- [ ] Check the InforU request format against the account documentation (`server/src/lib/inforu.ts`).
- [ ] Create the D1, R2 and KV resources, put their IDs in `wrangler.jsonc`, and set the secrets:
      `JWT_SECRET OTP_HMAC_SECRET BLOB_URL_SECRET INFORU_USER INFORU_TOKEN`.
- [ ] Data residency (§7.3, open decision 11.2): choose the location hint or jurisdiction for D1, R2 and DO.
- [ ] Recovery key (open decision): add a flow to restore the org from the key after every device is lost (the server side, wraps for `recovery`, already exists).
- [ ] Production app icon and splash. The in-app logo is drawn in `app/src/ui/kit.tsx`.
- [ ] Configure an EAS project ID for push notifications.

## Phase B (not implemented)
The plugin platform (SCIM, contexts API, Capability Manifest, HMAC webhooks, daily reconciliation) and the RapidOne plugin.
The hooks are already in place: `organizations.mode`, `managed_by` on users and contexts, `assertNotManaged()`
locks plugin-owned domains, `archive_docs.status/external_ref` for saving to an external record, and the
`/v1/security-events` endpoint.
