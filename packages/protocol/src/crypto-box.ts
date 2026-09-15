/**
 * E2E 加密信封（M4.75 / M14 §14.4/14.9）：ECDH P-256 派生共享密钥 + AES-256-GCM 密封，
 * Ed25519 内层签名防伪造。零依赖（Node crypto）；中继只见 { to, len, ts }。
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

/** 身份密钥：ECDH P-256（加密）+ Ed25519（签名），全部 base64url raw。
 *  P-256 公钥需 X+Y 两坐标（JWK 导出，非 65B 未压缩点）。 */
export interface IdentityKeys {
  encPubX: string;
  encPubY: string;
  encPriv: string;
  sigPub: string;
  sigPriv: string;
}

export interface SealedBox {
  iv: string; // base64
  tag: string; // base64
  ct: string; // base64
}

export function generateIdentityKeys(): IdentityKeys {
  const enc = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sig = generateKeyPairSync('ed25519');
  const encPub = enc.publicKey.export({ format: 'jwk' }) as { x?: string; y?: string };
  const encPriv = enc.privateKey.export({ format: 'jwk' }) as { d?: string };
  const sigPub = sig.publicKey.export({ format: 'jwk' }) as { x?: string };
  const sigPriv = sig.privateKey.export({ format: 'jwk' }) as { d?: string };
  if (!encPub.x || !encPub.y || !encPriv.d || !sigPub.x || !sigPriv.d)
    throw new Error('failed to export identity keys');
  return {
    encPubX: encPub.x,
    encPubY: encPub.y,
    encPriv: encPriv.d,
    sigPub: sigPub.x,
    sigPriv: sigPriv.d,
  };
}

function deriveAesKey(encPrivRaw: string, peerEncPubX: string, peerEncPubY: string): Buffer {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(encPrivRaw, 'base64url')); // P-256 私钥即 32B 标量
  // JWK.x/y 是无 0x04 前缀的 32B 坐标；组装标准 65B 未压缩公钥（0x04 || X || Y）
  const peerPub = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(peerEncPubX, 'base64url'),
    Buffer.from(peerEncPubY, 'base64url'),
  ]);
  const secret = ecdh.computeSecret(peerPub);
  return createHash('sha256').update(secret).digest(); // 32B AES key
}

/** 密封（发起方用自己的私钥 + 对端公钥 X/Y）。 */
export function sealTo(
  encPrivRaw: string,
  peerEncPubX: string,
  peerEncPubY: string,
  plaintext: string | Buffer,
): SealedBox {
  const aesKey = deriveAesKey(encPrivRaw, peerEncPubX, peerEncPubY);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

/** 开启（接收方用自己的私钥 + 对端公钥 X/Y）。篡改会抛错。 */
export function openFrom(
  encPrivRaw: string,
  peerEncPubX: string,
  peerEncPubY: string,
  box: SealedBox,
): Buffer {
  const aesKey = deriveAesKey(encPrivRaw, peerEncPubX, peerEncPubY);
  const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]);
}

function ed25519PrivateKey(sigPub: string, sigPriv: string) {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: sigPub, d: sigPriv },
    format: 'jwk',
  });
}

/** 签名（内层节点签名，中继不可伪造）。 */
export function signMessage(sigPub: string, sigPriv: string, message: string): string {
  const key = ed25519PrivateKey(sigPub, sigPriv);
  return sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}

export function verifySignature(sigPub: string, message: string, signature: string): boolean {
  try {
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: sigPub }, format: 'jwk' });
    return verify(null, Buffer.from(message, 'utf8'), pub, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** 中继路由信封（§14.9：零内容，只带路由头 + 长度）。 */
export interface Envelope {
  from: string;
  to: string;
  ts: number;
  box: SealedBox;
  len: number;
}

export function packEnvelope(
  from: string,
  to: string,
  box: SealedBox,
  plaintextLen: number,
): Envelope {
  return { from, to, ts: Date.now(), box, len: plaintextLen };
}
