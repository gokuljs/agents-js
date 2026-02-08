import type { VAD } from '../vad.js';
import { StreamAdapter } from './stream_adapter.js';
import { STT } from './stt.js';

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

class FallbackAdapter extends STT {
  label = 'stt.FallbackAdapter';
  readonly sttInstances: STT[];
  readonly attemptTimeout: number;
  readonly maxRetryPerSTT: number;
  readonly retryInterval: number;

  /** @internal */
  _status: STTStatus[];

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
    this.sttInstances.forEach((stt) => {
      stt.on('metrics_collected', (metrics) => {
        this.emit('metrics_collected', metrics);
      });
    });
  }
}
