export function readConfig(env = process.env) {
  const required = (name) => {
    if (!env[name]?.trim()) throw new Error(`Missing environment variable: ${name}`);
    return env[name].trim();
  };
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const flag = (name) => {
    const value = env[name] ?? 'true';
    if (!['true', 'false'].includes(value)) throw new Error(`Invalid ${name}`);
    return value === 'true';
  };
  const origin = (name) => {
    const value = new URL(required(name));
    if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.origin !== value.href.replace(/\/$/, '')) throw new Error(`Invalid origin: ${name}`);
    if (env.NODE_ENV === 'production' && value.protocol !== 'https:') throw new Error(`${name} must use HTTPS in production`);
    return value.origin;
  };
  const encryptionKey = required('SESSION_ENCRYPTION_KEY');
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) throw new Error('SESSION_ENCRYPTION_KEY must be 64 hexadecimal characters');
  const databaseTransport = env.DATABASE_TRANSPORT || 'postgres';
  if (!['postgres', 'supabase'].includes(databaseTransport)) throw new Error('DATABASE_TRANSPORT must be postgres or supabase');
  return {
    databaseTransport,
    databaseUrl: databaseTransport === 'postgres' ? required('DATABASE_URL') : null,
    poolMax: integer('DB_POOL_MAX', 10, 2, 50),
    host: env.HOST || '127.0.0.1', port: integer('PORT', 3000, 1, 65535),
    appOrigin: origin('APP_ORIGIN'), frontendOrigin: origin('FRONTEND_ORIGIN'),
    secureCookies: env.NODE_ENV === 'production', encryptionKey,
    sessionTtl: integer('SESSION_TTL_SECONDS', 28800, 3600, 86400),
    supabaseUrl: required('SUPABASE_URL'),
    supabasePublishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
    supabaseSecretKey: required('SUPABASE_SECRET_KEY'),
    slipBucket: env.SLIP_BUCKET || 'alumni69-slips',
    lineChannelId: env.LINE_CHANNEL_ID || '', lineChannelSecret: env.LINE_CHANNEL_SECRET || '',
    lineRedirectUri: env.LINE_REDIRECT_URI || '',
    oaAddFriendUrl: env.LINE_OA_ADD_FRIEND_URL || '', groupInviteUrl: env.LINE_GROUP_INVITE_URL || '',
    requireOaFriend: flag('REQUIRE_LINE_OA_FRIEND'), requireGroupAck: flag('REQUIRE_LINE_GROUP_ACK'),
    logger: true,
  };
}
