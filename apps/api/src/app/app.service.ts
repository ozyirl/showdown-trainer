import { Injectable } from '@nestjs/common';
import { CommonService } from '@org/common';

interface Message {
  text: string;
  welcomeMessage: string;
}

@Injectable()
export class AppService {
  constructor(private readonly commonService: CommonService) {}

  getData(): Message {
    return {
      text: 'Hello API',
      welcomeMessage: this.commonService.getWelcomeMessage(),
    };
  }
}
