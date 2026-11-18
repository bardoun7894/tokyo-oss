import crypto from "node:crypto";

// Web Push message encryption (RFC 8291) with the aes128gcm content coding (RFC 8188), built on node:crypto only: ECDH P-256, HKDF-SHA-256
// and AES-128-GCM. A device that stored `p256dh` (its 65-byte uncompressed P-256 public key) and `auth` (its 16-byte secret) at P1 gets
// every push as one encrypted record, so the push server and ntfy carry ciphertext only.

/** The record size written in the header. One record holds the whole message, so the plaintext plus its delimiter and the 16-byte tag fit in it. */
export const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;
const HEADER_ID_LENGTH = 65;
/** Two bytes of the record are not message: the 0x02 padding delimiter and (counted apart) the tag. */
const MAX_PLAINTEXT = RECORD_SIZE - TAG_LENGTH - 1;

export interface SubscriptionKeys { p256dh: string; auth: string }

export interface ContentKeyInputs {
  ecdhSecret: Buffer;
  /** The device's authentication secret (16 bytes). */
  auth: Buffer;
  /** The device's public key (65 bytes). */
  uaPublic: Buffer;
  /** The sender's public key for this message (65 bytes). */
  asPublic: Buffer;
  /** The record salt (16 bytes). */
  salt: Buffer;
}

const bytes = (b: ArrayBuffer): Buffer => Buffer.from(b);

/**
 * RFC 8291 section 3.4 and RFC 8188 section 2.2: the input keying material from the ECDH secret and the auth secret (key_info binds both
 * public keys), then the content encryption key (16 bytes) and the nonce (12 bytes) from the IKM and the record salt.
 * `hkdfSync` is extract-then-expand, which is what each step of the RFC is.
 */
export function deriveContentKeys(i: ContentKeyInputs): { keyInfo: Buffer; ikm: Buffer; cek: Buffer; nonce: Buffer } {
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), i.uaPublic, i.asPublic]);
  const ikm = bytes(crypto.hkdfSync("sha256", i.ecdhSecret, i.auth, keyInfo, 32));
  return {
    keyInfo,
    ikm,
    cek: bytes(crypto.hkdfSync("sha256", ikm, i.salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16)),
    nonce: bytes(crypto.hkdfSync("sha256", ikm, i.salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12)),
  };
}

export interface EncryptOptions {
  /** Test hooks only: the RFC example fixes the salt and the sender's private key. Production draws both at random per message. */
  salt?: Buffer;
  senderPrivateKey?: Buffer;
}

/**
 * The body of one push message for one device: header (salt, record size, key id length, the sender's public key) followed by the
 * AES-128-GCM record of `plaintext || 0x02`. Throws on a key that is not a P-256 point or an auth secret of the wrong length (the
 * message never contains the key), and on a plaintext that does not fit one record.
 */
export function encryptWebPush(plaintext: Buffer, keys: SubscriptionKeys, o: EncryptOptions = {}): Buffer {
  const uaPublic = Buffer.from(keys.p256dh, "base64");
  const auth = Buffer.from(keys.auth, "base64");
  if (uaPublic.length !== HEADER_ID_LENGTH || uaPublic[0] !== 4) throw new Error("the device's public key is not an uncompressed P-256 point");
  if (auth.length !== 16) throw new Error("the device's auth secret is not 16 bytes");
  if (plaintext.length > MAX_PLAINTEXT) throw new Error("the message is too large for one record");

  const sender = crypto.createECDH("prime256v1");
  if (o.senderPrivateKey) sender.setPrivateKey(o.senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  let ecdhSecret: Buffer;
  try {
    ecdhSecret = sender.computeSecret(uaPublic);
  } catch {
    throw new Error("the device's public key is not on the P-256 curve");
  }
  const salt = o.salt ?? crypto.randomBytes(16);
  const k = deriveContentKeys({ ecdhSecret, auth, uaPublic, asPublic, salt });

  const cipher = crypto.createCipheriv("aes-128-gcm", k.cek, k.nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = HEADER_ID_LENGTH;
  return Buffer.concat([header, asPublic, record]);
}
