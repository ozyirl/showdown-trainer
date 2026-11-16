import { Injectable } from '@nestjs/common';
import axios from 'axios';

const CHOOSE_TIMEOUT_MS = 5000;

/** The spike simulation and policy readout behind one Fly CNS decision. */
export interface FlyCnsDiagnostics {
  total_spikes: number;
  active_neurons: number;
  neuron_count: number;
  sensory_neurons_stimulated: number;
  steps: number | null;
  spikes_per_step: number[];
  populations: {
    key: string;
    label: string;
    neurons: number;
    active: number;
    spikes: number;
    first_spike_step: number | null;
  }[];
  top_descending: { root_id: number; cell_type: string; spikes: number }[];
  actions: {
    index: number;
    choice: string;
    label: string;
    probability: number;
    selected: boolean;
  }[];
  state_value: number;
  /** Per-neuron first spike step (255 = never) and spike count, as base64 bytes. */
  neuron_activity?: {
    graph: string;
    first_spike_step: string;
    spikes: string;
  } | null;
}

export interface FlyCnsChoice {
  choice: string;
  action_index: number;
  turn: number;
  state_value: number;
  diagnostics?: FlyCnsDiagnostics;
}

@Injectable()
export class FlyCnsService {
  private readonly baseUrl = (
    process.env.FLY_CNS_URL?.trim() || 'http://127.0.0.1:8000'
  ).replace(/\/+$/, '');

  async health(): Promise<unknown> {
    const response = await axios.get<unknown>(`${this.baseUrl}/health`);
    return response.data;
  }

  /**
   * Ask the Fly CNS policy for a choice, given everything one player has seen so far.
   * Tera and other gimmicks stay off because battles here only accept moves and switches.
   */
  async choose(
    format: string,
    protocol: string[],
    options?: { timeoutMs?: number }
  ): Promise<FlyCnsChoice> {
    const response = await axios.post<FlyCnsChoice>(
      `${this.baseUrl}/v1/choose`,
      { format, protocol, gimmicks: false },
      { timeout: options?.timeoutMs ?? CHOOSE_TIMEOUT_MS }
    );
    return response.data;
  }

  async debugPredict(): Promise<unknown> {
    const observation = Array.from(
      { length: 186 },
      (_, index) => -0.8 + (1.8 * index) / 185
    );
    observation[15] = 1;
    const legalActions = new Set([2, 7, 23]);

    const response = await axios.post<unknown>(`${this.baseUrl}/predict`, {
      observation,
      action_mask: Array.from({ length: 26 }, (_, index) =>
        legalActions.has(index) ? 1 : 0
      ),
    });
    return response.data;
  }
}
