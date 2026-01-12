import { Injectable } from '@nestjs/common';
import { CommonService } from '@org/common';

@Injectable()
export class AppService {
  constructor(private readonly commonService: CommonService) {}

  getData(): { message: string } {
    return { 
      message: 'Hello API',
      welcomeMessage: this.commonService.getWelcomeMessage()
    };
  }
}
