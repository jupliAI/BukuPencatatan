import { BlockchainService } from './types.ts';
import { MockBlockchainService } from './mock-blockchain.service.ts';
import { FabricBlockchainService } from './fabric-blockchain.service.ts';
import { RemoteBlockchainService } from './remote-blockchain.service.ts';

export type BlockchainProvider = 'fabric' | 'remote' | 'mock';

export class BlockchainFactory {
  private static instance: BlockchainService | null = null;
  private static forcedProvider: BlockchainProvider | null = null;

  public static setForcedProvider(provider: BlockchainProvider | null) {
    BlockchainFactory.forcedProvider = provider;
    BlockchainFactory.instance = null; // reset cached instance
  }

  public static getBlockchainService(): BlockchainService {
    if (!BlockchainFactory.instance) {
      const provider =
        BlockchainFactory.forcedProvider ||
        process.env.BLOCKCHAIN_PROVIDER ||
        (process.env.FABRIC_ENABLED === 'true' ? 'fabric' : 'mock');

      const normalized = provider.toLowerCase();

      if (normalized === 'fabric') {
        // Mode in-process: hanya valid pada Node long-running (VPS/Docker) yang punya
        // akses ke crypto-material dan koneksi gRPC langsung ke peer.
        BlockchainFactory.instance = new FabricBlockchainService();
      } else if (normalized === 'remote' || normalized === 'fabric-remote') {
        // Mode serverless: Vercel memanggil bridge di VPS via HTTPS.
        // Bila bridge belum dikonfigurasi, jangan crash — turun ke mock dengan peringatan.
        try {
          BlockchainFactory.instance = new RemoteBlockchainService();
        } catch (err) {
          console.warn(
            `[BlockchainFactory] Remote Fabric bridge tidak aktif (${
              err instanceof Error ? err.message : String(err)
            }). Fallback ke MockBlockchainService.`,
          );
          BlockchainFactory.instance = new MockBlockchainService();
        }
      } else {
        BlockchainFactory.instance = new MockBlockchainService();
      }
    }
    return BlockchainFactory.instance;
  }

  public static reset() {
    BlockchainFactory.instance = null;
    BlockchainFactory.forcedProvider = null;
  }
}
