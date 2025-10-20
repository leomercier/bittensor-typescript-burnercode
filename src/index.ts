import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/cjs/types';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { HttpCachingChain, HttpChainClient, type ChainOptions } from 'drand-client';
import pino, { type Logger } from 'pino';
import { roundAt, timelockEncrypt } from 'tlock-js';

dotenv.config({ quiet: true });

const defaultTempo = 360;
const defaultCommitRevealPeriod = 1;

export interface SubnetWeightsConfig {
    subnetConnection: SubnetConnectionConfig;
    drand: DrandConfig;
    logger?: LoggerConfig;
}

export interface SubnetConnectionConfig {
    networkUrl: string;
    subnetId: number;
    ss58Address: string;
    secretPhrase: string;
}

export interface DrandConfig {
    apiBaseUrl: string;
    chainHash: string;
    publicKey: string;
}

export interface LoggerConfig {
    level?: string;
    pretty?: boolean;
}

interface SubnetInfo {
    commitRevealEnabled: boolean;
    commitRevealPeriod: number;
    tempo: number;
}

interface SubnetScheduleParams {
    tempo: number;
    weightsRateLimit: number;
    activityCutoff: number;
    commitRevealEnabled: boolean;
    revealPeriodEpochs: number;
}

export interface SetWeightsResult {
    // For commit-reveal
    commitHash?: string;
    salt?: string;
    revealAfterBlocks?: number;
    targetRound?: number;

    // For standard
    standardHash?: string;
}

export class SubnetWeights {
    private config: SubnetWeightsConfig;
    private logger: Logger;

    private chainOptions: ChainOptions;

    private api: ApiPromise | null = null;
    private subnetInfo: SubnetInfo | null = null;
    private account: KeyringPair | null = null;

    constructor(config: SubnetWeightsConfig) {
        this.config = config;
        if (!this.validateConfig()) {
            throw new Error('Invalid SubnetWeightsConfig: Missing required Drand configuration fields');
        }

        this.logger = pino({
            level: this.config.logger?.level ?? 'info',
            transport: this.config.logger?.pretty
                ? {
                      target: 'pino-pretty',
                      options: { colorize: true }
                  }
                : undefined
        });

        this.chainOptions = {
            disableBeaconVerification: false,
            noCache: false,
            chainVerificationParams: {
                chainHash: this.config.drand.chainHash,
                publicKey: this.config.drand.publicKey
            }
        };
    }

    private validateConfig(): boolean {
        const drand = this.config.drand;
        return !!(drand.apiBaseUrl && drand.chainHash && drand.publicKey);
    }

    async setWeights(uids: number[], weights: number[]): Promise<SetWeightsResult> {
        if (uids.length !== weights.length) {
            throw new Error('Miner IDs and weights arrays must have the same length');
        }

        if (uids.length === 0) {
            throw new Error('Must provide at least one miner');
        }

        try {
            const subnetInfo = await this.getSubnetInfo();

            const normalizedWeights = this.normalizeWeights(weights);

            // Choose method based on commit-reveal setting
            if (subnetInfo.commitRevealEnabled) {
                const revealAfterBlocks = subnetInfo.commitRevealPeriod * subnetInfo.tempo;
                this.logger.debug(`Weights will be revealed after: ${revealAfterBlocks} blocks (~${Math.floor((revealAfterBlocks * 12) / 60)} minutes)\n`);

                const salt = crypto.randomBytes(8);
                const targetRound = await this.calculateTargetRound(revealAfterBlocks, 12);

                const { txHash, encryptedCommit, targetRound: actualTargetRound } = await this.commitCRWeights(uids, normalizedWeights, salt, targetRound);

                this.logger.debug('Weights committed successfully (CRv3).');
                this.logger.debug('Commit Details:');
                this.logger.debug(`  - Transaction Hash: ${txHash}`);
                this.logger.debug(`  - Target Drand Round: ${actualTargetRound}`);
                this.logger.debug(`  - Encrypted Data Size: ${encryptedCommit.length} bytes`);

                this.logger.debug(`The blockchain will automatically decrypt and reveal weights when Drand round ${actualTargetRound} is reached.`);

                return {
                    commitHash: txHash,
                    salt: salt.toString('hex'),
                    revealAfterBlocks,
                    targetRound: actualTargetRound
                };
            } else {
                this.logger.debug('Standard Mode (No Commit-Reveal)');

                const txHash = await this.setWeightsStandard(uids, weights);

                this.logger.debug('Weights set successfully.');

                return {
                    standardHash: txHash
                };
            }
        } catch (err) {
            this.logger.error(`Error setting weights: ${JSON.stringify(this.getErrorMetadata(err as Error))}`);
            throw err;
        }
    }

    private async commitCRWeights(uids: number[], weights: number[], salt: Uint8Array, targetRound: number): Promise<{ txHash: string; encryptedCommit: string; targetRound: number }> {
        const api = await this.getApi();
        const account = this.getAccount();
        const subnetId = this.config.subnetConnection.subnetId;

        const encryptedCommit = await this.createTimelockCommit(uids, weights, salt, targetRound);

        const extrinsics = Object.keys(api.tx.subtensorModule);
        this.logger.debug(`Available extrinsics: ${extrinsics.filter((e) => e.toLowerCase().includes('commit')).join(', ')}`);

        let commitTx;

        if (api.tx.subtensorModule.commitCrv3Weights) {
            this.logger.debug('Using: commitCrv3Weights (CRv3)');
            commitTx = api.tx.subtensorModule.commitCrv3Weights(subnetId, Array.from(encryptedCommit), targetRound);
        } else if (api.tx.subtensorModule.commitTimelockedWeights) {
            this.logger.debug('Using: commitTimelockedWeights (CRv4)');
            const commitRevealVersion = 4;
            commitTx = api.tx.subtensorModule.commitTimelockedWeights(subnetId, Array.from(encryptedCommit), targetRound, commitRevealVersion);
        } else {
            throw new Error(
                'Could not find CRv3 / CRv4 commit extrinsic. Available commit extrinsics: ' +
                    extrinsics.filter((e) => e.toLowerCase().includes('commit')).join(', ') +
                    '\n\nThis subnet may not support Drand timelock encryption. ' +
                    'Try using the simple hash approach instead.'
            );
        }

        this.logger.debug('Submitting timelock commit transaction ...');

        const txHash = await new Promise<string>((resolve, reject) => {
            commitTx
                .signAndSend(account, (result: any) => {
                    const { status, dispatchError } = result;
                    if (status.isFinalized) {
                        this.logger.debug(`Commit finalized: ${status.asFinalized.toHex()}`);
                        if (dispatchError) {
                            if (dispatchError.isModule) {
                                const decoded = api.registry.findMetaError(dispatchError.asModule);
                                reject(new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`));
                            } else {
                                reject(new Error(dispatchError.toString()));
                            }
                        } else {
                            resolve(status.asFinalized.toHex());
                        }
                    }
                })
                .catch(reject);
        });

        return { txHash, encryptedCommit, targetRound };
    }

    private async createTimelockCommit(uids: number[], weights: number[], salt: Uint8Array, targetRound: number): Promise<string> {
        const versionKey = 0;

        this.logger.debug('Creating Drand timelock encrypted commit ...');

        const data = Buffer.concat([
            Buffer.from(new Uint16Array(uids).buffer),
            Buffer.from(new Uint16Array(weights).buffer),
            salt,
            Buffer.from(new Uint32Array([versionKey]).buffer) //
        ]);

        const client = this.getDrandClient();

        const cipherText = await timelockEncrypt(targetRound, data, client);

        this.logger.debug('Timelock encryption complete');

        return cipherText;
    }

    private async setWeightsStandard(uids: any[], weights: any[]): Promise<string> {
        const api = await this.getApi();
        const account = this.getAccount();
        const subnetId = this.config.subnetConnection.subnetId;
        const versionKey = 0;

        const setWeightsTx = api.tx.subtensorModule.setWeights(subnetId, uids, weights, versionKey);

        this.logger.debug('Submitting standard set_weights transaction ...');

        return new Promise((resolve, reject) => {
            setWeightsTx
                .signAndSend(account, (result: { status?: any; events?: any; dispatchError?: any }) => {
                    const { status, events, dispatchError } = result;
                    if (status.isInBlock) {
                        this.logger.debug(`Transaction included in block: ${status.asInBlock.toHex()}`);
                    }

                    if (status.isFinalized) {
                        this.logger.debug(`Transaction finalized: ${status.asFinalized.toHex()}`);

                        if (dispatchError) {
                            if (dispatchError.isModule) {
                                const decoded = api.registry.findMetaError(dispatchError.asModule);
                                reject(new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`));
                            } else {
                                reject(new Error(dispatchError.toString()));
                            }
                        } else {
                            resolve(status.asFinalized.toHex());
                        }
                    }
                })
                .catch(reject);
        });
    }

    private async calculateTargetRound(blocksInFuture: number, blockTime: number = 12): Promise<number> {
        const client = this.getDrandClient();

        const chainInfo = await client.chain().info();

        this.logger.debug(`Drand Genesis Time: ${new Date(chainInfo.genesis_time * 1000).toISOString()}`);
        this.logger.debug(`Drand Period: ${chainInfo.period} seconds`);

        const currentTimeMs = Date.now();
        const targetTimeMs = currentTimeMs + blocksInFuture * blockTime * 1000;

        const targetRound = roundAt(targetTimeMs, chainInfo);

        return targetRound;
    }

    private getDrandClient(): HttpChainClient {
        const chain = new HttpCachingChain(`${this.config.drand.apiBaseUrl}/${this.config.drand.chainHash}`, this.chainOptions);
        const client = new HttpChainClient(chain);

        return client;
    }

    async disconnect(): Promise<void> {
        if (this.api) {
            await this.api.disconnect();
            this.api = null;
        }
    }

    private async getApi(): Promise<ApiPromise> {
        if (!this.api) {
            const wsProvider = new WsProvider(this.config.subnetConnection.networkUrl);
            this.api = await ApiPromise.create({ provider: wsProvider });
        }

        return this.api;
    }

    private async getSubnetInfo(): Promise<SubnetInfo> {
        if (this.subnetInfo) {
            return this.subnetInfo;
        }

        const api = await this.getApi();

        const subnetId = this.config.subnetConnection.subnetId;
        const commitRevealEnabled = await api.query.subtensorModule.commitRevealWeightsEnabled(subnetId);
        const revealPeriodEpochs = await api.query.subtensorModule.revealPeriodEpochs(subnetId);
        const tempo = await api.query.subtensorModule.tempo(subnetId);

        const subnetInfo: SubnetInfo = {
            commitRevealEnabled: commitRevealEnabled.toJSON() as boolean,
            commitRevealPeriod: (revealPeriodEpochs.toJSON() as number) || defaultCommitRevealPeriod,
            tempo: (tempo.toJSON() as number) || defaultTempo
        };

        this.logger.debug('Subnet Configuration:');
        this.logger.debug(`  - Commit-Reveal Enabled: ${subnetInfo.commitRevealEnabled}`);
        this.logger.debug(`  - Commit-Reveal Period: ${subnetInfo.commitRevealPeriod} tempos`);
        this.logger.debug(`  - Tempo: ${subnetInfo.tempo} blocks`);

        this.subnetInfo = subnetInfo;

        return this.subnetInfo;
    }

    private getAccount(): KeyringPair {
        if (this.account) {
            return this.account;
        }

        const keyring = new Keyring({ type: 'sr25519' });
        const account = keyring.addFromUri(this.config.subnetConnection.secretPhrase);

        if (account.address !== this.config.subnetConnection.ss58Address) {
            throw new Error('Private key does not match the provided SS58 address');
        }

        this.logger.debug(`Using account: ${account.address}`);

        this.account = account;

        return this.account;
    }

    private normalizeWeights(weights: number[]): number[] {
        const maxWeight = 1;
        const totalWeight = weights.reduce((sum, w) => sum + w, 0);
        const normalizedWeights = weights.map((weight) => Math.floor((weight / totalWeight) * maxWeight));

        this.logger.debug('Weight Normalization:');
        this.logger.debug(`  - Original: [${weights.join(', ')}]`);
        this.logger.debug(`  - Normalized: [${normalizedWeights.join(', ')}]`);

        return normalizedWeights;
    }

    getErrorMetadata(err: Error): Record<string, any> {
        let metadata: Record<string, any> = {};

        if (err) {
            metadata['message'] = err.message || '';
            metadata['stack'] = err.stack || '';
            metadata['name'] = err.name || '';
            metadata['cause'] = err.cause || '';
        }

        return metadata;
    }

    async continuousWeightSetting(updateWeightsCallback: () => Promise<{ uids: number[]; weights: number[] }>): Promise<void> {
        let iteration = 0;
        let lastCommitBlock = 0;

        this.logger.debug('Starting continuous weight setting loop ...');

        while (true) {
            iteration++;

            try {
                try {
                    const scheduleParams = await this.getSubnetScheduleParams();
                    const currentBlock = await this.getCurrentBlock();

                    this.logger.debug('Current State:');
                    this.logger.debug(`  - Current Block: ${currentBlock}`);
                    this.logger.debug(`  - Last Commit Block: ${lastCommitBlock || 'None'}`);
                    this.logger.debug(`  - Blocks Since Last Commit: ${lastCommitBlock ? currentBlock - lastCommitBlock : 'N/A'}`);

                    this.logger.debug('Subnet Configuration:');
                    this.logger.debug(`  - Tempo: ${scheduleParams.tempo} blocks (~${Math.floor((scheduleParams.tempo * 12) / 60)} min)`);
                    this.logger.debug(`  - Weights Rate Limit: ${scheduleParams.weightsRateLimit} blocks (~${Math.floor((scheduleParams.weightsRateLimit * 12) / 60)} min)`);
                    this.logger.debug(`  - Activity Cutoff: ${scheduleParams.activityCutoff} blocks (~${Math.floor((scheduleParams.activityCutoff * 12) / 60)} min)`);
                    this.logger.debug(`  - Commit-Reveal: ${scheduleParams.commitRevealEnabled ? 'Enabled' : 'Disabled'}`);

                    // Calculate if we can commit
                    const blocksSinceLastCommit = lastCommitBlock ? currentBlock - lastCommitBlock : Infinity;
                    const canCommit = blocksSinceLastCommit >= scheduleParams.weightsRateLimit;

                    if (!canCommit) {
                        const blocksToWait = scheduleParams.weightsRateLimit - blocksSinceLastCommit;
                        const minutesToWait = Math.ceil((blocksToWait * 12) / 60);

                        this.logger.debug(`Rate limit active. Need to wait ${blocksToWait} more blocks (~${minutesToWait} minutes)`);
                        this.logger.debug(`   Next commit available at block: ${lastCommitBlock + scheduleParams.weightsRateLimit}`);

                        // Sleep until we can commit (with a small buffer)
                        const sleepMs = blocksToWait * 12 * 1000 + 10000; // blocks * 12s + 10s buffer
                        this.logger.debug(`   Sleeping for ${Math.ceil(sleepMs / 1000 / 60)} minutes...`);

                        await this.disconnect();
                        await this.sleep(sleepMs);

                        continue;
                    }

                    this.logger.debug('Fetching updated weights from callback ...');
                    const { uids, weights } = await updateWeightsCallback();

                    const result = await this.setWeights(uids, weights);

                    lastCommitBlock = currentBlock;

                    this.logger.info('Weight commit successful!');
                    this.logger.info(`   Iteration: ${iteration}`);
                    this.logger.info(`   Transaction: ${result.commitHash || result.standardHash}`);
                    this.logger.info(`   Next commit available after block: ${lastCommitBlock + scheduleParams.weightsRateLimit}`);

                    const sleepBlocks = scheduleParams.weightsRateLimit;
                    const sleepMs = sleepBlocks * 12 * 1000 + 30000; // Add 30s buffer
                    const sleepMinutes = Math.ceil(sleepMs / 1000 / 60);

                    this.logger.info(`Sleeping for ${sleepMinutes} minutes until next commit window ...`);
                    await this.sleep(sleepMs);
                } finally {
                    await this.disconnect();
                }
            } catch (error) {
                this.logger.error(`Error in iteration ${iteration}: ${JSON.stringify(this.getErrorMetadata(error as Error))}`);

                this.logger.info('Waiting 5 minutes before retry ...');
                await this.sleep(5 * 60 * 1000);
            }
        }
    }

    private async getSubnetScheduleParams(): Promise<SubnetScheduleParams> {
        const api = await this.getApi();
        const subnetId = this.config.subnetConnection.subnetId;

        const tempo = await api.query.subtensorModule.tempo(subnetId);
        const weightsRateLimit = await api.query.subtensorModule.weightsSetRateLimit(subnetId);
        const activityCutoff = await api.query.subtensorModule.activityCutoff(subnetId);
        const commitRevealEnabled = await api.query.subtensorModule.commitRevealWeightsEnabled(subnetId);
        const revealPeriodEpochs = await api.query.subtensorModule.revealPeriodEpochs(subnetId);

        return {
            tempo: tempo.toJSON() as number,
            weightsRateLimit: weightsRateLimit.toJSON() as number,
            activityCutoff: activityCutoff.toJSON() as number,
            commitRevealEnabled: commitRevealEnabled.toJSON() as boolean,
            revealPeriodEpochs: revealPeriodEpochs.toJSON() as number
        };
    }

    private async getCurrentBlock(): Promise<number> {
        const api = await this.getApi();
        const blockNumber = await api.query.system.number();

        return blockNumber.toJSON() as number;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// Drand configuration - https://docs.drand.love/dev-guide/API%20Documentation%20v1/chains

async function main() {
    const config: SubnetWeightsConfig = {
        subnetConnection: {
            networkUrl: process.env.BITTENSOR_NETWORK_URL || '',
            subnetId: parseInt(process.env.BITTENSOR_SUBNET_ID || '0', 10),
            ss58Address: process.env.VALIDATOR_SS58_ADDRESS || '',
            secretPhrase: process.env.VALIDATOR_SECRET_PHRASE || ''
        },
        drand: {
            apiBaseUrl: process.env.DRAND_API_BASE_URL || '',
            chainHash: process.env.DRAND_CHAIN_HASH || '',
            publicKey: process.env.DRAND_PUBLIC_KEY || ''
        },
        logger: {
            level: 'debug',
            pretty: true
        }
    };

    try {
        console.log('Starting Bittensor Weight Setting...\n');

        const subnetWeights = new SubnetWeights(config);

        await subnetWeights.continuousWeightSetting(() => {
            return Promise.resolve({ uids: [0], weights: [1] });
        });

        await subnetWeights.disconnect();
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

main()
    .then(() => {
        console.log('Completed Bittensor Weight Setting');
    })
    .catch(console.error);
