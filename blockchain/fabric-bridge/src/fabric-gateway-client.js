/**
 * Klien Hyperledger Fabric Gateway untuk bridge service.
 *
 * Berbeda dengan `packages/blockchain/src/fabric-connection.manager.ts` (yang punya
 * mode simulasi agar development lokal tidak gagal), klien ini **gagal keras** bila
 * Fabric tidak tersedia. Alasannya: bridge adalah satu-satunya jalur aplikasi serverless
 * menuju ledger — kalau ia diam-diam mensimulasikan transaksi, aplikasi akan mengira
 * data tercatat on-chain padahal tidak.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { connect, signers } from '@hyperledger/fabric-gateway';

export class FabricGatewayClient {
  constructor(env = process.env) {
    this.config = {
      channelName: env.FABRIC_CHANNEL || 'procurementchannel',
      chaincodeName: env.FABRIC_CHAINCODE || 'procurement-ledger',
      mspId: env.FABRIC_MSP_ID || 'ProcurementMSP',
      peerEndpoint: env.FABRIC_PEER_ENDPOINT || 'localhost:7051',
      peerHostOverride: env.FABRIC_PEER_HOST_OVERRIDE || 'peer0.procurement.example.com',
      certPath: env.FABRIC_CERT_PATH || '',
      keyPath: env.FABRIC_KEY_PATH || '',
      tlsCertPath: env.FABRIC_TLS_CERT_PATH || '',
    };

    this.client = null;
    this.gateway = null;
    this.contract = null;
  }

  getConfig() {
    return { ...this.config };
  }

  isConnected() {
    return this.contract !== null;
  }

  /**
   * Membuka koneksi gRPC + Gateway sekali, lalu dipakai ulang untuk semua request.
   * Ini yang membuat bridge harus berupa proses long-running.
   */
  async connect() {
    if (this.contract) return this.contract;

    const { certPath, keyPath, tlsCertPath, peerEndpoint, peerHostOverride, mspId } = this.config;

    const missing = [
      ['FABRIC_CERT_PATH', certPath],
      ['FABRIC_KEY_PATH', keyPath],
      ['FABRIC_TLS_CERT_PATH', tlsCertPath],
    ].filter(([, value]) => !value);

    if (missing.length > 0) {
      throw new Error(
        `Konfigurasi Fabric belum lengkap. Env yang kosong: ${missing.map(([name]) => name).join(', ')}`,
      );
    }

    const notFound = [certPath, keyPath, tlsCertPath].filter((file) => !existsSync(file));
    if (notFound.length > 0) {
      throw new Error(`Crypto material tidak ditemukan: ${notFound.join(', ')}`);
    }

    const tlsRootCert = readFileSync(tlsCertPath);
    this.client = new grpc.Client(peerEndpoint, grpc.credentials.createSsl(tlsRootCert), {
      'grpc.ssl_target_name_override': peerHostOverride,
      'grpc.default_authority': peerHostOverride,
    });

    const identity = { mspId, credentials: readFileSync(certPath) };
    const privateKey = createPrivateKey(readFileSync(keyPath));

    this.gateway = connect({
      client: this.client,
      identity,
      signer: signers.newPrivateKeySigner(privateKey),
      evaluateOptions: () => ({ deadline: Date.now() + 10000 }),
      endorseOptions: () => ({ deadline: Date.now() + 20000 }),
      submitOptions: () => ({ deadline: Date.now() + 15000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });

    const network = this.gateway.getNetwork(this.config.channelName);
    this.contract = network.getContract(this.config.chaincodeName);
    return this.contract;
  }

  /** Transaksi tulis: proposal → endorsement → ordering → commit. */
  async submit(functionName, ...args) {
    const contract = await this.connect();
    const resultBytes = await contract.submitTransaction(functionName, ...args);
    return Buffer.from(resultBytes).toString('utf8');
  }

  /** Query read-only (tidak menulis blok baru). */
  async evaluate(functionName, ...args) {
    const contract = await this.connect();
    const resultBytes = await contract.evaluateTransaction(functionName, ...args);
    return Buffer.from(resultBytes).toString('utf8');
  }

  async health() {
    try {
      await this.connect();
      return {
        provider: 'fabric',
        status: 'connected',
        channel: this.config.channelName,
        chaincode: this.config.chaincodeName,
      };
    } catch (err) {
      return {
        provider: 'fabric',
        status: 'error',
        channel: this.config.channelName,
        chaincode: this.config.chaincodeName,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close() {
    if (this.gateway) {
      try {
        this.gateway.close();
      } catch {
        /* abaikan: proses sedang berhenti */
      }
      this.gateway = null;
    }
    if (this.client) {
      try {
        this.client.close();
      } catch {
        /* abaikan: proses sedang berhenti */
      }
      this.client = null;
    }
    this.contract = null;
  }
}
