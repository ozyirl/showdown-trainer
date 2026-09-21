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
}
