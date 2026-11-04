import { createClient } from '@supabase/supabase-js';
import { ApiError, fail } from './errors.js';

export function createProviders(config, { fetchImpl = fetch } = {}) {
  const timedFetch = (url, options = {}) => fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: timedFetch } };
  const admin = createClient(config.supabaseUrl, config.supabaseSecretKey, clientOptions);
  const authClient = () => createClient(config.supabaseUrl, config.supabasePublishableKey, clientOptions);
  const formRequest = async (url, form) => {
    let response;
    try { response = await timedFetch(url, { method: 'POST', body: new URLSearchParams(form) }); }
    catch { fail(502, 'LINE_UNAVAILABLE', 'LINE is temporarily unavailable'); }
    if (!response.ok) fail(response.status >= 500 ? 502 : 401, 'LINE_AUTH_FAILED', 'LINE authentication failed');
    return response.json();
  };
  return {
    async staffLogin(email, password) {
      const { data, error } = await authClient().auth.signInWithPassword({ email, password });
      if (error || !data.session) fail(401, 'INVALID_LOGIN', 'Invalid staff credentials');
      return data;
    },
    async staffRefresh(refreshToken) {
      const { data, error } = await authClient().auth.refreshSession({ refresh_token: refreshToken });
      if (error || !data.session) fail(401, 'INVALID_SESSION', 'Session could not be refreshed');
      return data;
    },
    async staffUser(token) {
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user) fail(401, 'INVALID_SESSION', 'Invalid or expired staff session');
      return data.user;
    },
    async staffLogout(token) {
      const { error } = await admin.auth.admin.signOut(token, 'local');
      if (error) fail(502, 'LOGOUT_FAILED', 'Could not revoke the staff session');
    },
    async exchangeLine(code, verifier, nonce) {
      const tokens = await formRequest('https://api.line.me/oauth2/v2.1/token', {
        grant_type: 'authorization_code', code, redirect_uri: config.lineRedirectUri,
        client_id: config.lineChannelId, client_secret: config.lineChannelSecret, code_verifier: verifier,
      });
      if (!tokens.id_token || !tokens.access_token) fail(401, 'LINE_AUTH_FAILED', 'Missing LINE tokens');
      const profile = await formRequest('https://api.line.me/oauth2/v2.1/verify', {
        id_token: tokens.id_token, client_id: config.lineChannelId, nonce,
      });
      if (profile.iss !== 'https://access.line.me' || profile.aud !== config.lineChannelId || profile.nonce !== nonce ||
          typeof profile.sub !== 'string' || !profile.sub || !Number.isFinite(profile.exp) || profile.exp <= Date.now() / 1000) fail(401, 'LINE_AUTH_FAILED', 'Invalid LINE identity');
      return { profile, accessToken: tokens.access_token };
    },
    async friendship(accessToken) {
      let response;
      try { response = await timedFetch('https://api.line.me/friendship/v1/status', { headers: { Authorization: `Bearer ${accessToken}` } }); }
      catch { fail(502, 'LINE_UNAVAILABLE', 'LINE is temporarily unavailable'); }
      if (!response.ok) fail(response.status === 401 ? 401 : 502, 'LINE_FRIENDSHIP_FAILED', 'Please sign in with LINE again');
      return (await response.json()).friendFlag === true;
    },
    async uploadSlip(path, bytes, contentType) {
      const { error } = await admin.storage.from(config.slipBucket).upload(path, bytes, { contentType, upsert: false });
      if (error) throw new ApiError(502, 'STORAGE_UPLOAD_FAILED', 'Could not store the slip');
    },
    async removeSlip(path) {
      const { error } = await admin.storage.from(config.slipBucket).remove([path]);
      if (error) throw new ApiError(502, 'STORAGE_CLEANUP_FAILED', 'Could not remove an unattached slip');
    },
    async signedSlip(path) {
      const { data, error } = await admin.storage.from(config.slipBucket).createSignedUrl(path, 120);
      if (error) fail(502, 'STORAGE_UNAVAILABLE', 'Could not open the slip');
      return data.signedUrl;
    },
  };
}
