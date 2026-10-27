import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { base58ToBytes } from '../../common/utils/base58.util';
import {
  ChainAccount,
  ChainInstruction,
  ChainNotConfiguredError,
  ChainTransaction,
  ChainUnavailableError,
  EscrowChainPort,
  SolanaCluster,
  SolanaCommitment,
} from './escrow-chain.port';

const RPC_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

interface JsonRpcResponse<T> {
  jsonrpc?: unknown;
  id?: unknown;
  result?: T;
  error?: { code?: number; message?: string };
}

/**
 * Plain JSON-RPC adapter.
 *
 * `fetch` is used rather than a Solana SDK: this service only reads, and adding a
 * key-handling dependency to the API would blur the boundary NFR-02 draws around
 * custody. Account decoding lives in the campaign deployment module and is
 * unit-tested against the Rust layout.
 *
 * Retries are bounded, jittered and only for failures that can be transient. A
 * JSON-RPC error response (a malformed request, for example) is not retried: it
 * would fail identically three times and delay the caller.
 */
@Injectable()
export class SolanaRpcAdapter implements EscrowChainPort {
  private readonly logger = new Logger(SolanaRpcAdapter.name);
  private readonly rpcUrl: string | null;

  readonly configured: boolean;
  readonly cluster: SolanaCluster;
  readonly programId: string;
  readonly commitment: SolanaCommitment;

  constructor(config: ConfigService<Env, true>) {
    this.rpcUrl = config.get('SOLANA_RPC_URL', { infer: true })?.trim() || null;
    this.cluster = config.get('SOLANA_CLUSTER', { infer: true });
    this.commitment = config.get('SOLANA_COMMITMENT', { infer: true });
    this.programId = config.get('ESCROW_PROGRAM_ID', { infer: true });
    // A provider switch is the explicit opt-in; a URL alone must not silently
    // turn a test build into one that talks to a live cluster.
    this.configured =
      config.get('ESCROW_CHAIN_PROVIDER', { infer: true }) === 'solana-rpc' &&
      this.rpcUrl !== null;
  }

  async getTransaction(signature: string): Promise<ChainTransaction> {
    const result = await this.rpc<{
      slot?: number;
      blockTime?: number | null;
      meta?: { err?: unknown } | null;
      transaction?: {
        message?: {
          accountKeys?: string[];
          instructions?: {
            programIdIndex?: number;
            accounts?: number[];
            data?: string;
          }[];
        };
      };
    } | null>('getTransaction', [
      signature,
      {
        commitment: this.commitment,
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      },
    ]);

    if (!result) {
      return {
        commitment: null,
        error: null,
        found: false,
        instructions: [],
        slot: null,
        success: false,
        blockTime: null,
      };
    }

    const accountKeys = result.transaction?.message?.accountKeys ?? [];
    const instructions: ChainInstruction[] = [];

    for (const instruction of result.transaction?.message?.instructions ?? []) {
      const programIndex = instruction.programIdIndex;
      const programId =
        typeof programIndex === 'number' ? accountKeys[programIndex] : undefined;
      if (!programId) continue;

      const accountAddresses = (instruction.accounts ?? [])
        .map((index) => accountKeys[index])
        .filter((address): address is string => typeof address === 'string');

      // `encoding: 'json'` returns instruction data as base58. The port speaks
      // base64 throughout, so normalise here rather than leaking the RPC quirk.
      let dataBase64 = '';
      if (instruction.data) {
        try {
          dataBase64 = Buffer.from(base58ToBytes(instruction.data)).toString('base64');
        } catch {
          this.logger.warn(`Ignoring instruction with invalid base58 data for ${programId}`);
          continue;
        }
      }

      instructions.push({
        accounts: accountAddresses,
        dataBase64,
        programId,
      });
    }

    const error = result.meta?.err;
    return {
      blockTime: result.blockTime ?? null,
      commitment: this.commitment,
      error:
        error === null || error === undefined
          ? null
          : typeof error === 'string'
            ? error
            : JSON.stringify(error).slice(0, 500),
      found: true,
      instructions,
      slot: result.slot ?? null,
      success: error === null || error === undefined,
    };
  }

  async getAccount(address: string): Promise<ChainAccount> {
    const result = await this.rpc<{
      context?: { slot?: number };
      value?: { data?: [string, string]; lamports?: number; owner?: string } | null;
    }>('getAccountInfo', [
      address,
      { commitment: this.commitment, encoding: 'base64' },
    ]);

    const value = result?.value;
    if (!value) {
      return { dataBase64: null, exists: false, lamports: null, owner: null };
    }

    return {
      dataBase64: Array.isArray(value.data) ? value.data[0] : null,
      exists: true,
      lamports:
        typeof value.lamports === 'number' ? BigInt(value.lamports) : null,
      owner: value.owner ?? null,
    };
  }

  async getRentExemptionLamports(bytes: number): Promise<bigint> {
    if (!Number.isInteger(bytes) || bytes <= 0) {
      throw new Error('Rent-exemption bytes must be a positive integer');
    }
    const lamports = await this.rpc<number>('getMinimumBalanceForRentExemption', [bytes]);
    return BigInt(lamports);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    if (!this.configured || !this.rpcUrl) throw new ChainNotConfiguredError();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.call<T>(method, params);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // A JSON-RPC error is deterministic: retrying cannot change the answer.
        if (error instanceof RpcResponseError) throw new ChainUnavailableError(error.message);

        if (attempt === MAX_ATTEMPTS - 1) break;

        const backoff = 250 * 2 ** attempt + Math.floor(Math.random() * 150);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    this.logger.warn(`${method} failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
    throw new ChainUnavailableError(lastError?.message);
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.rpcUrl as string, {
        body: JSON.stringify({ id: method, jsonrpc: '2.0', method, params }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch {
      throw new ChainUnavailableError('The Solana RPC request timed out or failed.');
    }

    if (response.status === 429 || response.status >= 500) {
      throw new ChainUnavailableError(`The Solana RPC returned ${response.status}.`);
    }
    if (!response.ok) {
      throw new RpcResponseError(`The Solana RPC rejected the request (${response.status}).`);
    }

    const body = (await response.json()) as JsonRpcResponse<T>;
    if (body.error) {
      throw new RpcResponseError(
        `Solana RPC error ${body.error.code ?? 'unknown'}: ${body.error.message ?? 'unknown'}`,
      );
    }
    return body.result as T;
  }
}

class RpcResponseError extends Error {}
