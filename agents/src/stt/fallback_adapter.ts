import type { AudioFrame } from '@livekit/rtc-node';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import type { AudioBuffer } from '../utils.js';
import type { VAD } from '../vad.js';
import { StreamAdapter } from './stream_adapter.js';
import { STT, type SpeechEvent, SpeechEventType, SpeechStream } from './stt.js';

const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 0,
  timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
  retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};
interface FallbackAdapterSTTOptions {
  stt: STT[];
  vad?: VAD;
  attemptTimeout: number;
  maxRetryPerSTT: number;
  retryInterval: number;
}

interface STTStatus {
  available: boolean;
  recoveringRecognizeTask: Promise<void> | null;
  recoveringStreamTask: Promise<void> | null;
}

export interface AvailabilityChangedEvent {
  stt: STT;
  available: boolean;
}

export class FallbackAdapter extends STT {
  label = 'stt.FallbackAdapter';
  readonly sttInstances: STT[];
  readonly attemptTimeout: number;
  readonly maxRetryPerSTT: number;
  readonly retryInterval: number;

  /** @internal */
  _status: STTStatus[];
  private logger = log();
  constructor(options: FallbackAdapterSTTOptions) {
    let sttList = [...options.stt];
    if (sttList.length < 1) {
      throw new Error('At least one STT instances must be provided');
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
    this.attemptTimeout = options.attemptTimeout ?? 10;
    this.maxRetryPerSTT = options.maxRetryPerSTT ?? 2;
    this.retryInterval = options.retryInterval ?? 5;
    this._status = this.sttInstances.map(() => ({
      available: true,
      recoveringRecognizeTask: null,
      recoveringStreamTask: null,
    }));
    this.logger = log();
    this.sttInstances.forEach((stt) => {
      stt.on('metrics_collected', (metrics) => {
        this.emit('metrics_collected', metrics);
      });
    });
  }

  _emitAvailabilityChanged(stt: STT, available: boolean): void {
    const event: AvailabilityChangedEvent = { stt, available };
    (this as unknown as { emit: (event: string, data: AvailabilityChangedEvent) => void }).emit(
      'stt_availability_changed',
      event,
    );
  }

  private async tryRecognize(
    stt: STT,
    buffer: AudioBuffer,
    abortSignal?: AbortSignal,
    recovering = false,
  ): Promise<SpeechEvent> {
    try {
      return await stt.recognize(buffer, abortSignal);
    } catch (error) {
      if (error instanceof APIError) {
        if (recovering) {
          this.logger.warn({ stt: stt.label, error }, 'recovery failed');
        } else {
          this.logger.warn({ stt: stt.label, error }, 'failed, switching to next STT');
        }
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        if (recovering) {
          this.logger.warn({ stt: stt.label }, 'recovery timed out');
        } else {
          this.logger.warn({ stt: stt.label }, 'timed out, switching to next STT');
        }
        throw error;
      }

      if (recovering) {
        this.logger.error({ stt: stt.label, error }, 'recovery unexpected error');
      } else {
        this.logger.error({ stt: stt.label, error }, 'unexpected error, switching to next STT');
      }
      throw error;
    }
  }

  private tryRecognizeRecovery(stt: STT, buffer: AudioBuffer): void {
    const index = this.sttInstances.indexOf(stt);
    const status = this._status[index]!;

    if (status.recoveringRecognizeTask !== null) {
      return;
    }

    const recoverTask = async (): Promise<void> => {
      try {
        await this.tryRecognize(stt, buffer, undefined, true);
        status.available = true;
        this.logger.info({ stt: stt.label }, 'STT recovered (recognize)');
        this._emitAvailabilityChanged(stt, true);
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
    const totalSTTInstanceLength = this.sttInstances.length;
    const allSTTFailed = this._status.every((stt) => !stt.available);
    if (allSTTFailed) {
      throw new Error('All STT instances failed, retrying...');
    }
    for (let i = 0; i < totalSTTInstanceLength; i++) {
      const stt = this.sttInstances[i]!;
      const status = this._status[i];
      if (status?.available || allSTTFailed) {
        try {
          return await this.tryRecognize(stt, buffer, abortSignal, false);
        } catch (error) {
          if (status?.available) {
            status.available = false;
            this._emitAvailabilityChanged(stt, false);
          }
        }
      }
      this.tryRecognizeRecovery(stt, buffer);
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
    for (const status of this._status) {
      status.recoveringRecognizeTask = null;
      status.recoveringStreamTask = null;
    }
    for (const stt of this.sttInstances) {
      stt.off('metrics_collected', () => {});
    }
  }

  updateOptions(kwargs: Record<string, unknown>): void {
    for (const stt of this.sttInstances) {
      if ('updateOptions' in stt && typeof (stt as any).updateOptions === 'function') {
        try {
          (stt as any).updateOptions(kwargs);
        } catch (error) {
          this.logger.warn(
            { stt: stt.label, error },
            'Failed to update options. Ensure options are compatible with this provider.',
          );
        }
      }
    }
  }
}

class FallbackSpeechStream extends SpeechStream {
  label = 'stt.FallbackSpeechStream';

  private adapter: FallbackAdapter;
  private recoveringStreams: SpeechStream[] = [];
  private _log = log();
  private _connOpts: APIConnectOptions;

  constructor(adapter: FallbackAdapter, opts: { connOptions: APIConnectOptions }) {
    super(adapter, undefined, opts.connOptions);
    this.adapter = adapter;
    this._connOpts = opts.connOptions;
  }

  protected async run(): Promise<void> {
    const startTime = Date.now();

    const allFailed = this.adapter._status.every((s) => !s.available);
    if (allFailed) {
      this._log.error('all STTs are unavailable, retrying...');
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
        } catch (error) {
          this._log.error({ error }, 'error forwarding input');
        }
      })();
    };

    for (let i = 0; i < this.adapter.sttInstances.length; i++) {
      const stt = this.adapter.sttInstances[i]!;
      const status = this.adapter._status[i]!;

      if (status.available || allFailed) {
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
      }

      this.tryStreamRecovery(stt, i);
    }

    for (const stream of this.recoveringStreams) {
      try {
        stream.close();
      } catch {
        // ignore
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    const labels = this.adapter.sttInstances.map((s) => s.label).join(', ');
    throw new APIConnectionError({
      message: `all STTs failed (${labels}) after ${duration.toFixed(2)}s`,
    });
  }

  private tryStreamRecovery(stt: STT, index: number): void {
    const status = this.adapter._status[index]!;

    if (status.recoveringStreamTask !== null) {
      return;
    }

    const connOptions: APIConnectOptions = {
      ...this.connOptions,
      maxRetry: 0,
      timeoutMs: this.adapter.attemptTimeout * 1000,
    };

    const stream = stt.stream({ connOptions });
    this.recoveringStreams.push(stream);

    const recoverTask = async (): Promise<void> => {
      try {
        let transcriptCount = 0;

        for await (const ev of stream) {
          if (ev.type === SpeechEventType.FINAL_TRANSCRIPT) {
            if (!ev.alternatives || !ev.alternatives[0].text) {
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
        const idx = this.recoveringStreams.indexOf(stream);
        if (idx !== -1) {
          this.recoveringStreams.splice(idx, 1);
        }
        status.recoveringStreamTask = null;
      }
    };

    status.recoveringStreamTask = recoverTask();
  }

  close() {
    for (const stream of this.recoveringStreams) {
      try {
        stream.close();
      } catch {
        // ignore
      }
    }
    this.recoveringStreams = [];
    super.close();
  }
}
