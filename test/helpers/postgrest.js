import { createServer } from 'node:http';
// HTTP contract substitute for PostgREST, executing the real RPC under service_role.
export async function postgrestHarness(pool) {
  const server = createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.method !== 'POST' || request.url !== '/rest/v1/rpc/alumni69_backend') return send(404, { code: 'NOT_FOUND' });
    if (request.headers.apikey !== 'test-service-secret' || request.headers.authorization !== 'Bearer test-service-secret') return send(403, { code: '42501', message: 'permission denied' });
    let client;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error('body too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE service_role');
      const { rows: [row] } = await client.query('SELECT public.alumni69_backend($1,$2::jsonb) AS result', [body.p_action, JSON.stringify(body.p_data || {})]);
      await client.query('COMMIT');
      return send(200, row.result);
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      return send(/^PT\d{3}$/.test(error.code || '') ? Number(error.code.slice(2)) : 400, { code: error.code || 'BAD_REQUEST', message: error.message });
    } finally { if (client) client.release(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
