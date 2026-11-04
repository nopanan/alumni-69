import { randomBytes } from 'node:crypto';
export function testConfig() {
  return {
    logger: false, rateLimit: false, appOrigin: 'http://localhost:3000', frontendOrigin: 'http://localhost:5173',
    secureCookies: false, encryptionKey: randomBytes(32).toString('hex'), sessionTtl: 28800,
    lineChannelId: 'test-channel', lineChannelSecret: 'test-channel-secret',
    lineRedirectUri: 'http://localhost:3000/auth/line/callback',
    requireOaFriend: true, requireGroupAck: true,
    oaAddFriendUrl: 'https://line.me/test-oa', groupInviteUrl: 'https://line.me/test-group',
  };
}
