/*
  lib/messaging 공개 API
  - 외부(app/*)는 이 파일만 import한다. Provider 구체 클래스를 직접 import하지 않는다.
*/

import { MessageService } from "./MessageService";
import { getMessageProvider } from "./MessageProviderFactory";

export function getMessageService(): MessageService {
  return new MessageService(getMessageProvider());
}

export type {
  MessageChannel,
  MessageProvider,
  SendMessageInput,
  SendMessageResult,
} from "./types";
export { MessageService } from "./MessageService";
