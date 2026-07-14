import crypto from 'node:crypto';

const secret = globalThis.process?.env?.AUTH_SECRET || 'quiz-pliz-local-development-secret';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

export function createToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, role: user.role, name: user.name, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readToken(token = '') {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('AUTH_REQUIRED');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('AUTH_REQUIRED');
  const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (user.exp < Date.now()) throw new Error('AUTH_REQUIRED');
  return user;
}
