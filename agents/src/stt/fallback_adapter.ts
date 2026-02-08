// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import type { STTMetrics } from '../metrics/base.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import type { AudioBuffer } from '../utils.js';
import type { VAD } from '../vad.js';
import { StreamAdapter } from './stream_adapter.js';
import { STT, type SpeechEvent, SpeechEventType, SpeechStream } from './stt.js';

/**
 * Default timeout in seconds for each STT attempt before falling back to the next provider.
 */
const DEFAULT_ATTEMPT_TIMEOUT_SECONDS = 10;

/**
 * Default maximum number of retries per STT provider before marking it as unavailable.
 */
const DEFAULT_MAX_RETRY_PER_STT = 2;

/**
 * Default interval in seconds between recovery attempts for failed STT providers.
 */
const DEFAULT_RETRY_INTERVAL_SECONDS = 5;

const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 0,
  timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
  retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};

/**
 * Configuration options for the FallbackAdapter.
 */
export interface FallbackAdapterSTTOptions {
  /** Array of STT providers to use, in order of preference. */
  stt: STT[];
  /** Optional VAD instance required for non-streaming STT providers. */
  vad?: VAD;
  /** Timeout in seconds for each STT attempt. Default: 10 */
  attemptTimeout?: number;
  /** Maximum retries per STT provider before marking unavailable. Default: 2 */
  maxRetryPerSTT?: number;
  /** Interval in seconds between recovery attempts. Default: 5 */
  retryInterval?: number;
}

interface STTStatus {
  available: boolean;
  recoveringRecognizeTask: Promise<void> | null;
  recoveringStreamTask: Promise<void> | null;
}

/**
 * Event emitted when an STT provider's availability status changes.
 */
export interface AvailabilityChangedEvent {
  stt: STT;
  available: boolean;
}

/**
 * A fallback adapter that cycles through multiple STT providers for resilience.
 *
 * When the primary STT provider fails, the adapter automatically switches to the next
 * available provider. Failed providers are monitored in the background and restored
 * when they become healthy again.
 *
 * @example
 * ```typescript
 * const fallbackSTT = new FallbackAdapter({
 *   stt: [primarySTT, backupSTT],
 *   attemptTimeout: 10,
 *   maxRetryPerSTT: 2,
 * });
 * ```
 */
export class FallbackAdapter extends STT {
  label = 'stt.FallbackAdapter';
  readonly sttInstances: STT[];
  readonly attemptTimeout: number;
  readonly maxRetryPerSTT: number;
  readonly retryInterval: number;

  /** @internal */
  _status: STTStatus[];
  private logger = log();
  private metricsListeners: Map<STT, (metrics: STTMetrics) => void> = new Map();
  constructor(options: FallbackAdapterSTTOptions) {
    let sttList = [...options.stt];
    if (sttList.length < 1) {
      throw new Error('At least one STT instance must be provided');
    }
    const nonStreamingSTT = sttList.filter((s) => !s.capabilities.streaming);
    if (nonStreamingSTT.length > 0) {
      if (!options.vad) {
        const labels = nonStreamingSTT.map((s) => s.label).join(', ');
        throw new Error(
          `STTs do not support streaming: ${labels}. Provide a VAD to enable StreamAdapter automatically.`,
        );
      }
      sttList = sttList.map((s) =>
        s.capabilities.streaming ? s : new StreamAdapter(s, options.vad!),
      );
    }

    super({
      streaming: true,
      interimResults: sttList.every((s) => s.capabilities.interimResults),
    });

    this.sttInstances = sttList;
    this.attemptTimeout = options.attemptTimeout ?? DEFAULT_ATTEMPT_TIMEOUT_SECONDS;
    this.maxRetryPerSTT = options.maxRetryPerSTT ?? DEFAULT_MAX_RETRY_PER_STT;
    this.retryInterval = options.retryInterval ?? DEFAULT_RETRY_INTERVAL_SECONDS;
    this._status = this.sttInstances.map(() => ({
      available: true,
      recoveringRecognizeTask: null,
      recoveringStreamTask: null,
    }));
    this.sttInstances.forEach((stt) => {
      const listener = (metrics: STTMetrics) => {
        this.emit('metrics_collected', metrics);
      };
      this.metricsListeners.set(stt, listener);
      stt.on('metrics_collected', listener);
    });
  }

  /**
   * Emits an availability changed event for the given STT provider.
   * @internal
   */
  _emitAvailabilityChanged(stt: STT, available: boolean): void {
    const event: AvailabilityChangedEvent = { stt, available };
    this.emit('stt_availability_changed' as 'metrics_collected', event as unknown as STTMetrics);
  }

  /**
   * Returns whether all STT providers are currently unavailable.
   */
  private isAllUnavailable(): boolean {
    return this._status.every((s) => !s.available);
  }

  /**
   * Attempts to recognize speech using the specified STT provider.
   */
  private async tryRecognize(
    stt: STT,
    buffer: AudioBuffer,
    abortSignal?: AbortSignal,
    recovering = false,
  ): Promise<SpeechEvent> {
    try {
      return await stt.recognize(buffer, abortSignal);
    } catch (error) {
      const context = recovering ? 'recovery' : 'recognition';

      if (error instanceof APIError) {
        if (recovering) {
          this.logger.warn({ stt: stt.label, error }, 'recovery failed');
        } else {
          this.logger.warn({ stt: stt.label, error }, 'failed, switching to next STT');
        }
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.warn({ stt: stt.label }, `${context} timed out`);
        throw error;
      }

      this.logger.error({ stt: stt.label, error }, `${context} unexpected error`);
      throw error;
    }
  }

  /**
   * Initiates a background recovery task for the specified STT provider.
   * Recovery tasks attempt to restore unavailable providers without blocking main operations.
   */
  private tryRecognizeRecovery(stt: STT, buffer: AudioBuffer, abortSignal?: AbortSignal): void {
    const index = this.sttInstances.indexOf(stt);
    if (index === -1) return;

    const status = this._status[index]!;

    if (status.recoveringRecognizeTask !== null || status.available) {
      return;
    }

    const recoverTask = async (): Promise<void> => {
      try {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), this.attemptTimeout * 1000);
        const abortHandler = () => timeoutController.abort();
        abortSignal?.addEventListener('abort', abortHandler);
        try {
          await this.tryRecognize(stt, buffer, timeoutController.signal, true);
          status.available = true;
          this.logger.info({ stt: stt.label }, 'STT recovered (recognize)');
          this._emitAvailabilityChanged(stt, true);
        } finally {
          clearTimeout(timeoutId);
          abortSignal?.removeEventListener('abort', abortHandler);
        }
      } catch {
        // Recovery failed, stay unavailable
      } finally {
        status.recoveringRecognizeTask = null;
      }
    };

    status.recoveringRecognizeTask = recoverTask();
  }

  protected async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<SpeechEvent> {
    const startTime = Date.now();
    const allUnavailable = this.isAllUnavailable();
    if (allUnavailable) {
      this.logger.warn('all STTs are unavailable, attempting anyway');
    }

    for (let i = 0; i < this.sttInstances.length; i++) {
      const stt = this.sttInstances[i]!;
      const status = this._status[i]!;

      if (status.available || allUnavailable) {
        try {
          return await this.tryRecognize(stt, buffer, abortSignal, false);
        } catch {
          if (status.available) {
            status.available = false;
            this._emitAvailabilityChanged(stt, false);
          }
        }
      } else {
        this.tryRecognizeRecovery(stt, buffer, abortSignal);
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    const labels = this.sttInstances.map((s) => s.label).join(', ');
    throw new APIConnectionError({
      message: `all STTs failed (${labels}) after ${duration.toFixed(2)}s`,
    });
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new FallbackSpeechStream(this, {
      connOptions: options?.connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
    });
  }

  async close(): Promise<void> {
    // Clear recovery tasks
    for (const status of this._status) {
      status.recoveringRecognizeTask = null;
      status.recoveringStreamTask = null;
    }

    for (const stt of this.sttInstances) {
      const listener = this.metricsListeners.get(stt);
      if (listener) {
        stt.off('metrics_collected', listener);
      }
      await stt.close();
    }
    this.metricsListeners.clear();
  }

  updateOptions(kwargs: Record<string, unknown>): void {
    for (const stt of this.sttInstances) {
      const sttWithOptions = stt as STT & {
        updateOptions?: (opts: Record<string, unknown>) => void;
      };
      if ('updateOptions' in stt && typeof sttWithOptions.updateOptions === 'function') {
        try {
          sttWithOptions.updateOptions(kwargs);
        } catch (error) {
          this.logger.warn(
            { stt: stt.label, error },
            'Failed to update options. Ensure options are compatible with this provider.',
          );
        }
      }
    }
  }
  getSTTStatus(): ReadonlyArray<{ stt: STT; available: boolean }> {
    return this.sttInstances.map((stt, i) => ({
      stt,
      available: this._status[i]!.available,
    }));
  }
}

class FallbackSpeechStream extends SpeechStream {
  label = 'stt.FallbackSpeechStream';

  private adapter: FallbackAdapter;
  private recoveringStreams: Set<SpeechStream> = new Set();
  private _log = log();
  private _connOpts: APIConnectOptions;

  constructor(adapter: FallbackAdapter, opts: { connOptions: APIConnectOptions }) {
    super(adapter, undefined, opts.connOptions);
    this.adapter = adapter;
    this._connOpts = opts.connOptions;
  }

  protected async run(): Promise<void> {
    const startTime = Date.now();

    const allUnavailable = this.adapter._status.every((s) => !s.available);
    if (allUnavailable) {
      this._log.warn('all STTs are unavailable, attempting anyway');
    }

    let mainStream: SpeechStream | null = null;
    let forwardInputTask: Promise<void> | null = null;

    const startForwardInput = () => {
      if (forwardInputTask !== null) {
        return;
      }

      forwardInputTask = (async () => {
        try {
          for await (const data of this.input) {
            for (const stream of this.recoveringStreams) {
              try {
                if (data === SpeechStream.FLUSH_SENTINEL) {
                  stream.flush();
                } else {
                  stream.pushFrame(data as AudioFrame);
                }
              } catch {
                // stream may have been closed
              }
            }

            if (mainStream !== null) {
              try {
                if (data === SpeechStream.FLUSH_SENTINEL) {
                  mainStream.flush();
                } else {
                  mainStream.pushFrame(data as AudioFrame);
                }
              } catch {
                // stream may have been closed
              }
            }
          }
          if (mainStream !== null) {
            try {
              mainStream.endInput();
            } catch {
              // stream may have been closed
            }
          }

          for (const stream of this.recoveringStreams) {
            try {
              stream.endInput();
            } catch {
              // stream may have been closed
            }
          }
        } catch (error) {
          this._log.error({ error }, 'error forwarding input');
        }
      })();
    };

    for (let i = 0; i < this.adapter.sttInstances.length; i++) {
      const stt = this.adapter.sttInstances[i]!;
      const status = this.adapter._status[i]!;

      if (status.available || allUnavailable) {
        try {
          const connOptions: APIConnectOptions = {
            ...this._connOpts,
            maxRetry: this.adapter.maxRetryPerSTT,
            timeoutMs: this.adapter.attemptTimeout * 1000,
            retryIntervalMs: this.adapter.retryInterval * 1000,
          };

          mainStream = stt.stream({ connOptions });
          startForwardInput();

          for await (const ev of mainStream) {
            this.queue.put(ev);
          }

          return;
        } catch (error) {
          if (error instanceof APIError) {
            this._log.warn({ stt: stt.label, error }, 'failed, switching to next STT');
          } else if (error instanceof Error && error.name === 'AbortError') {
            this._log.warn({ stt: stt.label }, 'timed out, switching to next STT');
          } else {
            this._log.error({ stt: stt.label, error }, 'unexpected error, switching to next STT');
          }

          if (status.available) {
            status.available = false;
            this.adapter._emitAvailabilityChanged(stt, false);
          }

          mainStream = null;
        }
      } else {
        this.tryStreamRecovery(stt, i);
      }
    }

    this.cleanupRecoveringStreams();

    const duration = (Date.now() - startTime) / 1000;
    const labels = this.adapter.sttInstances.map((s) => s.label).join(', ');
    throw new APIConnectionError({
      message: `all STTs failed (${labels}) after ${duration.toFixed(2)}s`,
    });
  }

  private cleanupRecoveringStreams(): void {
    for (const stream of this.recoveringStreams) {
      try {
        stream.close();
      } catch {
        // ignore
      }
    }
    this.recoveringStreams.clear();
  }

  private tryStreamRecovery(stt: STT, index: number): void {
    const status = this.adapter._status[index]!;

    if (status.recoveringStreamTask !== null || status.available) {
      return;
    }

    const connOptions: APIConnectOptions = {
      ...this._connOpts,
      maxRetry: 0,
      timeoutMs: this.adapter.attemptTimeout * 1000,
      retryIntervalMs: this.adapter.retryInterval * 1000,
    };

    const stream = stt.stream({ connOptions });
    this.recoveringStreams.add(stream);

    const recoverTask = async (): Promise<void> => {
      try {
        let transcriptCount = 0;

        for await (const ev of stream) {
          if (ev.type === SpeechEventType.FINAL_TRANSCRIPT) {
            if (!ev.alternatives || !ev.alternatives[0]?.text) {
              continue;
            }
            transcriptCount++;
            break;
          }
        }

        if (transcriptCount === 0) {
          return;
        }

        status.available = true;
        this._log.info({ stt: stt.label }, 'STT recovered (stream)');
        this.adapter._emitAvailabilityChanged(stt, true);
      } catch (error) {
        if (error instanceof APIError) {
          this._log.warn({ stt: stt.label, error }, 'stream recovery failed');
        } else if (error instanceof Error && error.name === 'AbortError') {
          this._log.warn({ stt: stt.label }, 'stream recovery timed out');
        } else {
          this._log.error({ stt: stt.label, error }, 'stream recovery unexpected error');
        }
      } finally {
        this.recoveringStreams.delete(stream);
        try {
          stream.close();
        } catch {
          // ignore
        }
        status.recoveringStreamTask = null;
      }
    };

    status.recoveringStreamTask = recoverTask();
  }

  close() {
    this.cleanupRecoveringStreams();
    super.close();
  }
}
