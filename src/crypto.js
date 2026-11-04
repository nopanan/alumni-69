import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
export const opaque = () => randomBytes(32).toString('base64url');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const challenge = (value) => createHash('sha256').update(value).digest('base64url');
export function encrypt(value, hexKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64url');
}
export function decrypt(value, hexKey) {
  const data = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
}
