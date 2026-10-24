// A stand-in for the ERP's host API: GET desired, POST report, bearer-checked.

import { createServer, type Server } from 'node:http';
import type { Desired, Report } from '../../src/types.js';

export interface MockServer {
  url: string;
  desired: Desired | null | 'error' | 'garbage';
  reports: Report[];
  requests: { method: string; path: string; auth: string | undefined }[];
  close(): Promise<void>;
}

export async function startMockServer(hostId: string, token: string, desired: Desired): Promise<MockServer> {
  const mock: Omit<MockServer, 'url' | 'close'> = { desired, reports: [], requests: [] };
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    mock.requests.push({ method: req.method ?? '', path, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const base = `/api/fleet/hosts/${encodeURIComponent(hostId)}/`;
    if (req.method === 'GET' && path === `${base}desired`) {
      if (mock.desired === 'error') return void res.writeHead(500).end();
      if (mock.desired === 'garbage') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"nope":true}');
      if (mock.desired === null) return void res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mock.desired));
      return;
    }
    if (req.method === 'POST' && path === `${base}report`) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        mock.reports.push(JSON.parse(body) as Report);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return Object.assign(mock, {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  });
}
