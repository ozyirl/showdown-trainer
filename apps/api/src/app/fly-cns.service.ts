import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class FlyCnsService {
  private readonly baseUrl = (
    process.env.FLY_CNS_URL?.trim() || 'http://127.0.0.1:8000'
  ).replace(/\/+$/, '');

  async health(): Promise<unknown> {
    const response = await axios.get<unknown>(`${this.baseUrl}/health`);
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
