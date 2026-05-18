/**
 * @stellarpay/sdk — Stellar Client
 * Initializes and exposes Horizon + Soroban RPC clients for a given network.
 */

import {
  Horizon,
  Networks,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Operation,
  Asset,
  Contract,
  rpc as SorobanRpc,
  xdr,
} from '@stellar/stellar-sdk';
import type { StellarPayConfig, StellarNetwork } from './types.js';

const NETWORK_DEFAULTS: Record<
  StellarNetwork,
  { rpcUrl: string; horizonUrl: string; passphrase: string }
> = {
  mainnet: {
    rpcUrl: 'https://soroban-rpc.stellar.org',
    horizonUrl: 'https://horizon.stellar.org',
    passphrase: Networks.PUBLIC,
  },
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: Networks.TESTNET,
  },
  futurenet: {
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    passphrase: Networks.FUTURENET,
  },
};

export const VAULT_CONTRACT_IDS: Record<StellarNetwork, string> = {
  mainnet: 'CSTELLARPAY_VAULT_MAINNET_CONTRACT_ADDRESS_PLACEHOLDER',
  testnet: 'CSTELLARPAY_VAULT_TESTNET_CONTRACT_ADDRESS_PLACEHOLDER',
  futurenet: 'CSTELLARPAY_VAULT_FUTURENET_CONTRACT_ADDRESS_PLACEHOLDER',
};

export class StellarClient {
  readonly keypair: Keypair;
  readonly horizon: Horizon.Server;
  readonly soroban: SorobanRpc.Server;
  readonly networkPassphrase: string;
  readonly vaultContractId: string;

  constructor(config: StellarPayConfig) {
    const defaults = NETWORK_DEFAULTS[config.network];

    this.keypair = Keypair.fromSecret(config.signerKey);
    this.networkPassphrase = defaults.passphrase;
    this.vaultContractId =
      config.vaultContractId ?? VAULT_CONTRACT_IDS[config.network];

    this.horizon = new Horizon.Server(config.horizonUrl ?? defaults.horizonUrl);
    this.soroban = new SorobanRpc.Server(config.rpcUrl ?? defaults.rpcUrl);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  /** Load the current account for transaction building */
  async loadAccount(): Promise<Horizon.AccountResponse> {
    return this.horizon.loadAccount(this.publicKey);
  }

  /** Build a base TransactionBuilder pre-configured for this network */
  async buildTransaction(
    sourceAccount: Horizon.AccountResponse
  ): Promise<TransactionBuilder> {
    return new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });
  }

  /** Submit a signed transaction to Horizon */
  async submitTransaction(
    tx: ReturnType<TransactionBuilder['build']>
  ): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
    tx.sign(this.keypair);
    return this.horizon.submitTransaction(tx);
  }

  /** Upload and invoke a Soroban contract function */
  async invokeContract(params: {
    contractId: string;
    method: string;
    args: xdr.ScVal[];
  }): Promise<SorobanRpc.Api.GetTransactionResponse> {
    const account = await this.loadAccount();
    const contract = new Contract(params.contractId);

    const tx = new TransactionBuilder(account, {
      fee: '1000000', // higher fee for Soroban ops
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(params.method, ...params.args)
      )
      .setTimeout(30)
      .build();

    // Simulate first to get footprint
    const simulation = await this.soroban.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(`Soroban simulation failed: ${simulation.error}`);
    }

    const prepared = SorobanRpc.assembleTransaction(tx, simulation).build();
    prepared.sign(this.keypair);

    const response = await this.soroban.sendTransaction(prepared);
    if (response.status === 'ERROR') {
      throw new Error(`Transaction failed: ${response.errorResult?.toXDR('base64')}`);
    }

    // Poll for result
    return this.pollTransaction(response.hash);
  }

  private async pollTransaction(
    hash: string,
    maxAttempts = 20,
    intervalMs = 1500
  ): Promise<SorobanRpc.Api.GetTransactionResponse> {
    for (let i = 0; i < maxAttempts; i++) {
      const result = await this.soroban.getTransaction(hash);
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        return result;
      }
      await sleep(intervalMs);
    }
    throw new Error(`Transaction ${hash} not confirmed after ${maxAttempts} attempts`);
  }

  /** Parse an asset code into a Stellar Asset object */
  parseAsset(code: string): Asset {
    if (code === 'XLM') return Asset.native();
    // For well-known anchored assets, include issuer. For now, treat as native-style.
    // Production usage: maintain an asset registry mapping code → (code, issuer).
    throw new Error(
      `Asset '${code}' requires an issuer. Use StellarClient.assetFromCode(code, issuer) or register in asset registry.`
    );
  }

  assetFromCode(code: string, issuer: string): Asset {
    return new Asset(code, issuer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
