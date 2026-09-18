/**
 * The audio-thread side of the engine: wraps EngineSynth in an
 * AudioWorkletProcessor. Runs off the main thread, so a busy frame never
 * glitches the engine note.
 *
 * Controls arrive as messages at display rate and are held until the next;
 * the synth itself smooths nothing, so the model on the main thread does.
 */
import { EngineSynth, type SynthControls } from './engineSynth.ts';
import type { VoiceParams } from './profiles.ts';

// The AudioWorkletGlobalScope is not in TypeScript's DOM lib.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

type Message =
  | { type: 'controls'; controls: SynthControls }
  | { type: 'voice'; voice: VoiceParams }
  | { type: 'flutter'; strength: number };

class EngineVoiceProcessor extends AudioWorkletProcessor {
  private synth: EngineSynth;
  private controls: SynthControls = {
    rpm: 900,
    rpmFraction: 0.1,
    load: 0,
    boost: 0,
    overrun: 0,
    cut: false,
    idleRpm: 900,
  };

  constructor(options: { processorOptions: { voice: VoiceParams } }) {
    super();
    this.synth = new EngineSynth(options.processorOptions.voice, sampleRate);
    this.port.onmessage = (e: MessageEvent<Message>) => {
      const m = e.data;
      if (m.type === 'controls') this.controls = m.controls;
      else if (m.type === 'voice') this.synth.voice = m.voice;
      else if (m.type === 'flutter') this.synth.triggerFlutter(m.strength);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    if (!channels || channels.length === 0) return true;
    this.synth.render(channels[0], this.controls);
    for (let c = 1; c < channels.length; c++) channels[c].set(channels[0]);
    return true;
  }
}

registerProcessor('engine-voice', EngineVoiceProcessor);
