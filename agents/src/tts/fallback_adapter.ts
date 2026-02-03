// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SentenceTokenizer } from "../tokenize/index.js";
import { TTS, type TTSCapabilities } from "./tts.js";
import { log } from '../log.js';


interface TTSStatus {
    available: boolean;
    recoveringTask: Promise<void> | null;
    recoveryController: AbortController | null;
}

interface FallbackAdapterOptions {
    ttsInstances: TTS[];
    sentenceTokenizer?: SentenceTokenizer;
    attemptTimeOut?: number;
    maxRetryPerTts?: number;
    recoverInterval?: number;
}


class FallbackAdapter extends TTS {
    readonly ttsInstances: TTS[];
    readonly attemptTimeOut: number;
    readonly maxRetryPerTTS: number;
    readonly recoverInterval: number;

    _status: TTSStatus[];
    #sentenceTokenizer: SentenceTokenizer;
    #logger = log();

    label: string = 'tts.FallbackAdapter';

    constructor(options: FallbackAdapterOptions) {
        if (!options.ttsInstances || options.ttsInstances.length < 1) {
            throw new Error('At least one TTS instance muse be provided')
        }
        const numChannels = options.ttsInstances[0]!.numChannels;
        const sampleRate = options.ttsInstances[0]!.sampleRate;
        const capabilities = FallbackAdapter.#aggregateCapabilities(options.ttsInstances);
        super(sampleRate, numChannels, capabilities);
        this.ttsInstances = options.ttsInstances;
        this.attemptTimeOut = options.attemptTimeOut ?? 5.0;
        this.maxRetryPerTTS=options.maxRetryPerTts ?? 0;
        this.recoverInterval=options.recoverInterval ?? 0.5;
        
    }

    static #aggregateCapabilities(ttsInstances: TTS[]): TTSCapabilities {
        const streaming = ttsInstances.some(tts => tts.capabilities.streaming);
        const alignedTranscript = ttsInstances.every(tts => tts.capabilities.alignedTranscript);
        return { streaming, alignedTranscript };
    }



}