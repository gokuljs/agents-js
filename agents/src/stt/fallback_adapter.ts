import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import type { AudioBuffer } from '../utils.js';
import type { VAD } from '../vad.js';
import { StreamAdapter } from './stream_adapter.js';
import { STT, type SpeechEvent } from './stt.js';

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

class FallbackAdapter extends STT {
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
    const nonStreamingSTT = options.stt.filter((s) => !s.capabilities.streaming);
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
}
