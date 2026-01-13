import { Injectable } from '@nestjs/common';

@Injectable()
export class CommonService {
  getWelcomeMessage(): string {
    return 'Welcome from the shared common library!';
  }
}
