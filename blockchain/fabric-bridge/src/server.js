/**
 * Fabric Bridge Service — podman/docker/Node long-running di VPS.
 *
 * Tugasnya: memegang koneksi Hyperledger Fabric Gateway, lalu membukanya sebagai
 * HTTP API sederhana yang aman dipanggil dari Vercel (serverless).
 *
 * Menjalankan:
 *   npm install
 *   node src/server.js
 *
 * Variabel lingkungan: lihat .env.example pada folder ini.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { FabricGatewayClient } from './fabric-gateway-client.js';

const PORT = Number(process.env.BRIDGE_PORT) || 8080;
const HOST = process.env.BRIDGE_HOST || '0.0.0.0';
const TOKEN = process.env.BRIDGE_TOKEN || '';
const MAX_BODY_BYTES = Number(process.env.BRIDGE_MAX_BODY_BYTES) || 1024 * 1024;

const fabric = new FabricGatewayClient();

/** Perbandingan token yang aman terhadap timing attack (aman untuk panjang berbeda). */
function tokenMatches(provided) {
  const a = Buffer.from(provided ?? '', 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function send(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body melebihi batas ${MAX_BODY_BYTES} byte`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`Body bukan JSON valid: ${err instanceof Error ? err.message : err}`));
      }
    });
  });
}

/** Melempar error ber-HttpStatus agar bisa dipetakan ke kode respons yang tepat. */
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

class FabricError extends Error {}

function splitPath(pathname) {
  return pathname.split('/').filter((segment) => segment.length > 0);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const segments = splitPath(url.pathname);

  if (req.method === 'GET' && url.pathname === '/v1/health') {
    send(res, 200, await fabric.health());
    return;
  }

  // Semua endpoint selain /v1/health wajib menyertakan bearer token bila BRIDGE_TOKEN diset.
  if (TOKEN) {
    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!tokenMatches(provided)) {
      throw new HttpError(401, 'Unauthorized: bearer token tidak valid');
    }
  }

  // POST /v1/events — mencatat audit event ke ledger
  if (req.method === 'POST' && url.pathname === '/v1/events') {
    const event = await readJsonBody(req);
    if (!event || typeof event !== 'object' || !event.eventId) {
      throw new HttpError(400, 'Body harus berupa LedgerEvent dengan field eventId');
    }

    const resultJson = await fabric.submit('recordEvent', JSON.stringify(event));
    const parsed = JSON.parse(resultJson);
    if (!parsed.success) {
      throw new FabricError(parsed.message || 'Chaincode menolak transaksi');
    }

    send(res, 200, {
      success: true,
      transactionId: parsed.transactionId,
      duplicate: parsed.duplicate === true,
    });
    return;
  }

  // GET /v1/events/:eventId/exists
  if (req.method === 'GET' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'events' && segments[3] === 'exists') {
    const eventId = decodeURIComponent(segments[2]);
    const raw = await fabric.evaluate('eventExists', eventId);
    let exists = false;
    try {
      exists = JSON.parse(raw) === true;
    } catch {
      exists = raw === 'true';
    }
    send(res, 200, { exists });
    return;
  }

  // GET /v1/entities/:entityType/:entityId/history
  if (
    req.method === 'GET' &&
    segments.length === 5 &&
    segments[0] === 'v1' &&
    segments[1] === 'entities' &&
    segments[4] === 'history'
  ) {
    const entityType = decodeURIComponent(segments[2]);
    const entityId = decodeURIComponent(segments[3]);
    const raw = await fabric.evaluate('getEntityHistory', entityType, entityId);
    send(res, 200, { events: JSON.parse(raw) });
    return;
  }

  // POST /v1/verify-document-hash
  if (req.method === 'POST' && url.pathname === '/v1/verify-document-hash') {
    const { entityId, documentHash } = await readJsonBody(req);
    if (!entityId || !documentHash) {
      throw new HttpError(400, 'entityId dan documentHash wajib diisi');
    }
    const raw = await fabric.evaluate('verifyDocumentHash', String(entityId), String(documentHash));
    send(res, 200, JSON.parse(raw));
    return;
  }

  throw new HttpError(404, `Route ${req.method} ${url.pathname} tidak dikenal`);
}

const handler = (req, res) => {
  route(req, res).catch((err) => {
    // 4xx dari HttpError (validasi/auth), 502 untuk kegagalan chaincode/Gateway.
    const status = err instanceof HttpError ? err.statusCode : 502;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[fabric-bridge] ${req.method} ${req.url} → ${status}: ${message}`);
    send(res, status, { error: message });
  });
};

const tlsCertPath = process.env.BRIDGE_TLS_CERT;
const tlsKeyPath = process.env.BRIDGE_TLS_KEY;

const server =
  tlsCertPath && tlsKeyPath
    ? createHttpsServer({ cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) }, handler)
    : createHttpServer(handler);

server.listen(PORT, HOST, () => {
  const scheme = tlsCertPath && tlsKeyPath ? 'https' : 'http';
  const config = fabric.getConfig();
  console.log(`[fabric-bridge] listening on ${scheme}://${HOST}:${PORT}`);
  console.log(
    `[fabric-bridge] channel=${config.channelName} chaincode=${config.chaincodeName} peer=${config.peerEndpoint}`,
  );
  console.log(`[fabric-bridge] bearer token: ${TOKEN ? 'aktif' : 'TIDAK AKTIF (jangan dipakai di production)'}`);
});

/** Tutup koneksi gRPC dengan rapi supaya peer tidak menyisakan sesi menggantung. */
const shutdown = async (signal) => {
  console.log(`[fabric-bridge] menerima ${signal}, menutup...`);
  await fabric.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
