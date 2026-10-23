import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
// Hanya tipe yang di-import statis: SDK Fabric (gRPC) dimuat lewat `import()` dinamis
// di dalam `connect()` supaya provider `mock`/`remote` tidak ikut memuatnya saat boot.
import type * as grpc from '@grpc/grpc-js';
import type { Contract, Gateway, Identity, Signer } from '@hyperledger/fabric-gateway';

export interface FabricConfig {
  channelName: string;
  chaincodeName: string;
  mspId: string;
  peerEndpoint: string;
  peerHostOverride: string;
  certPath: string;
  keyPath: string;
  tlsCertPath: string;
}

export class FabricConnectionManager {
  private static instance: FabricConnectionManager;
  private config: FabricConfig;
  private client: grpc.Client | null = null;
  private gateway: Gateway | null = null;
  private contract: Contract | null = null;
  private connected: boolean = false;
  private isSimulatedMode: boolean = false;

  constructor(customConfig?: Partial<FabricConfig>) {
    this.config = {
      channelName: process.env.FABRIC_CHANNEL || customConfig?.channelName || 'procurementchannel',
      chaincodeName: process.env.FABRIC_CHAINCODE || customConfig?.chaincodeName || 'procurement-ledger',
      mspId: process.env.FABRIC_MSP_ID || customConfig?.mspId || 'ProcurementMSP',
      peerEndpoint: process.env.FABRIC_PEER_ENDPOINT || customConfig?.peerEndpoint || 'localhost:7051',
      peerHostOverride: process.env.FABRIC_PEER_HOST_OVERRIDE || customConfig?.peerHostOverride || 'peer0.procurement.example.com',
      certPath:
        process.env.FABRIC_CERT_PATH ||
        customConfig?.certPath ||
        path.resolve(process.cwd(), 'blockchain/fabric-network/crypto-material/peerOrganizations/procurement.example.com/users/app-client/msp/signcerts/cert.pem'),
      keyPath:
        process.env.FABRIC_KEY_PATH ||
        customConfig?.keyPath ||
        path.resolve(process.cwd(), 'blockchain/fabric-network/crypto-material/peerOrganizations/procurement.example.com/users/app-client/msp/keystore/priv_sk'),
      tlsCertPath:
        process.env.FABRIC_TLS_CERT_PATH ||
        customConfig?.tlsCertPath ||
        path.resolve(process.cwd(), 'blockchain/fabric-network/crypto-material/peerOrganizations/procurement.example.com/peers/peer0.procurement.example.com/tls/ca.crt'),
    };
  }

  public static getInstance(customConfig?: Partial<FabricConfig>): FabricConnectionManager {
    if (!FabricConnectionManager.instance) {
      FabricConnectionManager.instance = new FabricConnectionManager(customConfig);
    }
    return FabricConnectionManager.instance;
  }

  public getConfig(): Omit<FabricConfig, 'keyPath'> {
    const { keyPath, ...safeConfig } = this.config;
    return safeConfig;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public isSimulated(): boolean {
    return this.isSimulatedMode;
  }

  /**
   * Initializes connection to Fabric Gateway using TLS credentials and client identity
   */
  public async connect(): Promise<Contract> {
    if (this.contract && this.connected) {
      return this.contract;
    }

    try {
      // 1. Verify existence of certificates
      const tlsCertExists = fs.existsSync(this.config.tlsCertPath);
      const certExists = fs.existsSync(this.config.certPath);
      const keyExists = fs.existsSync(this.config.keyPath);

      if (!tlsCertExists || !certExists || !keyExists) {
        console.warn(
          `[Fabric Gateway] Crypto material not found at specified paths. Entering simulated Gateway mode for local dev environment.`
        );
        this.isSimulatedMode = true;
        this.connected = true;
        return this.createSimulatedContract();
      }

      // 2. Muat SDK Fabric hanya saat koneksi nyata ke peer diperlukan.
      const grpc = await import('@grpc/grpc-js');
      const { connect, signers } = await import('@hyperledger/fabric-gateway');

      // 3. Load TLS root CA
      const tlsRootCert = fs.readFileSync(this.config.tlsCertPath);
      const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);

      // 4. Create gRPC client to Fabric Peer
      this.client = new grpc.Client(this.config.peerEndpoint, tlsCredentials, {
        'grpc.ssl_target_name_override': this.config.peerHostOverride,
        'grpc.default_authority': this.config.peerHostOverride,
      });

      // 5. Load client identity (X.509 Certificate)
      const credentials = fs.readFileSync(this.config.certPath);
      const identity: Identity = {
        mspId: this.config.mspId,
        credentials,
      };

      // 6. Load private key & create signer
      const privateKeyPem = fs.readFileSync(this.config.keyPath);
      const privateKey = crypto.createPrivateKey(privateKeyPem);
      const signer: Signer = signers.newPrivateKeySigner(privateKey);

      // 7. Connect to Gateway
      this.gateway = connect({
        client: this.client,
        identity,
        signer,
        evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
        endorseOptions: () => ({ deadline: Date.now() + 15000 }),
        submitOptions: () => ({ deadline: Date.now() + 10000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
      });

      const network = this.gateway.getNetwork(this.config.channelName);
      this.contract = network.getContract(this.config.chaincodeName);
      this.connected = true;
      this.isSimulatedMode = false;

      return this.contract;
    } catch (err: any) {
      console.warn(
        `[Fabric Gateway] Could not connect to remote peer (${err.message}). Activating local Fabric Gateway simulation mode.`
      );
      this.isSimulatedMode = true;
      this.connected = true;
      return this.createSimulatedContract();
    }
  }

  /**
   * High-fidelity simulated contract executing the exact same ProcurementLedgerContract logic
   * when running in environments without a running Docker peer container.
   */
  private simulatedState: Map<string, Buffer> = new Map();
  private simulatedTxCount: number = 2000;

  private createSimulatedContract(): Contract {
    const self = this;
    const contractMock: Partial<Contract> = {
      chaincodeName: this.config.chaincodeName,
      async submitTransaction(name: string, ...args: (string | Uint8Array)[]): Promise<Uint8Array> {
        self.simulatedTxCount++;
        const simulatedTxId = `tx_fabric_${crypto
          .createHash('sha256')
          .update(`tx-${self.simulatedTxCount}-${Date.now()}`)
          .digest('hex')
          .substring(0, 32)}`;

        // Execute against ProcurementLedgerContract
        const { ProcurementLedgerContract } = await import(
          '../../../blockchain/chaincode/src/procurement-contract.ts'
        );
        const contract = new ProcurementLedgerContract();

        const stubMock: any = {
          getTxID: () => simulatedTxId,
          getState: async (k: string) => self.simulatedState.get(k) || Buffer.from(''),
          putState: async (k: string, v: Buffer) => self.simulatedState.set(k, Buffer.from(v)),
          deleteState: async (k: string) => self.simulatedState.delete(k),
          setEvent: (_evName: string, _payload: Buffer) => {},
        };

        const ctxMock: any = { stub: stubMock };

        if (name === 'recordEvent') {
          const res = await contract.recordEvent(ctxMock, String(args[0]));
          return Buffer.from(res, 'utf8');
        }

        throw new Error(`Unknown transaction function: ${name}`);
      },

      async evaluateTransaction(name: string, ...args: (string | Uint8Array)[]): Promise<Uint8Array> {
        const { ProcurementLedgerContract } = await import(
          '../../../blockchain/chaincode/src/procurement-contract.ts'
        );
        const contract = new ProcurementLedgerContract();

        const stubMock: any = {
          getTxID: () => `tx_query_${Date.now()}`,
          getState: async (k: string) => self.simulatedState.get(k) || Buffer.from(''),
          putState: async (k: string, v: Buffer) => self.simulatedState.set(k, Buffer.from(v)),
          deleteState: async (k: string) => self.simulatedState.delete(k),
          setEvent: () => {},
        };

        const ctxMock: any = { stub: stubMock };

        if (name === 'getEvent') {
          const res = await contract.getEvent(ctxMock, String(args[0]));
          return Buffer.from(res, 'utf8');
        }
        if (name === 'getEntityHistory') {
          const res = await contract.getEntityHistory(ctxMock, String(args[0]), String(args[1]));
          return Buffer.from(res, 'utf8');
        }
        if (name === 'getEntityState') {
          const res = await contract.getEntityState(ctxMock, String(args[0]), String(args[1]));
          return Buffer.from(res, 'utf8');
        }
        if (name === 'verifyDocumentHash') {
          const res = await contract.verifyDocumentHash(ctxMock, String(args[0]), String(args[1]));
          return Buffer.from(res, 'utf8');
        }
        if (name === 'eventExists') {
          const res = await contract.eventExists(ctxMock, String(args[0]));
          return Buffer.from(JSON.stringify(res), 'utf8');
        }

        throw new Error(`Unknown query function: ${name}`);
      },
    };

    return contractMock as Contract;
  }

  public async close(): Promise<void> {
    if (this.gateway) {
      try {
        this.gateway.close();
      } catch {}
      this.gateway = null;
    }
    if (this.client) {
      try {
        this.client.close();
      } catch {}
      this.client = null;
    }
    this.contract = null;
    this.connected = false;
  }
}
