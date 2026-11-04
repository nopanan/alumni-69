import { ApiError } from '../../src/errors.js';
export const STAFF = {
  admin: '00000000-0000-4000-8000-000000000001',
  staff: '00000000-0000-4000-8000-000000000002',
  manager: '00000000-0000-4000-8000-000000000003',
};
// Deliberately injected only by tests/demo. Production server never imports this.
export function mockProviders() {
  const objects = new Map(), revoked = new Set();
  return {
    objects, isFriend: true, uploadFailure: false, afterUpload: null,
    async exchangeLine(code) {
      return { profile: { sub: `line-test-${code}`, name: `Test ${code}` }, accessToken: `line-access-${code}` };
    },
    async friendship() { return this.isFriend; },
    async staffLogin(email, password) {
      const role = email.split('@')[0];
      if (!STAFF[role] || password !== 'test-only-password') throw new ApiError(401, 'INVALID_LOGIN', 'Invalid credentials');
      revoked.delete(`test-staff-${role}`);
      return { user: { id: STAFF[role] }, session: { access_token: `test-staff-${role}`, refresh_token: `refresh-${role}`, expires_in: 3600 } };
    },
    async staffRefresh(token) {
      return this.staffLogin(`${token.replace('refresh-', '')}@example.test`, 'test-only-password');
    },
    async staffUser(token) {
      const role = token.replace('test-staff-', '');
      if (!token.startsWith('test-staff-') || !STAFF[role] || revoked.has(token)) throw new ApiError(401, 'INVALID_SESSION', 'Invalid session');
      return { id: STAFF[role], user_metadata: { role: 'admin' } };
    },
    async staffLogout(token) { revoked.add(token); },
    async uploadSlip(path, bytes, type) {
      if (this.uploadFailure) throw new ApiError(502, 'STORAGE_UPLOAD_FAILED', 'Storage unavailable');
      objects.set(path, { bytes, type });
      if (this.afterUpload) await this.afterUpload();
    },
    async removeSlip(path) { objects.delete(path); },
    async signedSlip(path) { return `https://storage.example.test/${path}?expires=120`; },
  };
}
