export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: MessageContentPart[];
  thinking_steps?: Array<{ thought: string; [key: string]: any }>;
}