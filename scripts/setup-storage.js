import { createClient } from '@supabase/supabase-js';
import { readConfig } from '../src/config.js';
const config = readConfig();
const client = createClient(config.supabaseUrl, config.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: bucket, error: lookupError } = await client.storage.getBucket(config.slipBucket);
if (bucket) {
  if (bucket.public) throw new Error('Existing slip bucket is public. Review its configuration before use.');
  console.log('Private slip bucket already exists; no changes made.');
} else {
  if (lookupError && !['404', '400'].includes(String(lookupError.statusCode))) throw new Error('Cannot inspect the slip bucket; check Storage permissions');
  const { error } = await client.storage.createBucket(config.slipBucket, { public: false, fileSizeLimit: 5 * 1024 * 1024, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] });
  if (error) throw new Error(`Cannot create slip bucket (${error.statusCode || 'storage error'})`);
  console.log('Created private slip bucket.');
}
