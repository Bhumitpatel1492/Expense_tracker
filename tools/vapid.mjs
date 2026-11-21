// Generates a VAPID key pair for Web Push (no dependencies).
// The PUBLIC key goes into config.js (vapidPublicKey). The PRIVATE key goes into the data repo's
// GitHub Actions secret VAPID_PRIVATE_KEY — never commit it.
// Usage: node tools/vapid.mjs [output.json]
import fs from 'node:fs';

const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
const privateKey = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;
const out = process.argv[2];
if (out) {
  fs.writeFileSync(out, JSON.stringify({ publicKey, privateKey }, null, 2) + '\n', { mode: 0o600 });
  console.log('VAPID keys saved to', out);
  console.log('Public key:', publicKey);
} else {
  console.log(JSON.stringify({ publicKey, privateKey }, null, 2));
}
