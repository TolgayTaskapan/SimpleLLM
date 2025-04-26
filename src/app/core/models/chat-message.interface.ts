export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: MessageContentPart[];
  thinking_steps?: Array<{ thought: string; [key: string]: any }>;
  isLoading?: boolean;
  isPlaceholderReplaced?: boolean; // Add property to track placeholder replacement
  tool_calls?: any[]; // Add optional tool_calls property
  tool_call_id?: string; // Add optional tool_call_id property
  messageType?: 'user' | 'assistant' | 'tool_interaction'; // Add message type for different rendering
  toolName?: string; // Add tool name for tool interaction messages
  toolStep?: 'call' | 'response'; // Add tool step (call or response)
  toolData?: any; // Add tool data (arguments or response)
}