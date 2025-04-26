import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Model } from '../models/model.interface';
import { ChatMessage } from '../models/chat-message.interface';

@Injectable({
  providedIn: 'root'
})
export class OpenRouterService {
  private apiUrl = '/api'; // Point to the backend API base path

  constructor(private http: HttpClient) {}

  getModels(apiKey: string): Observable<Model[]> {
    const headers = new HttpHeaders().set('Authorization', `Bearer ${apiKey}`);
    // Call the backend endpoint for models
    return this.http.get<Model[]>('http://localhost:8000/api/get_models', { headers });
  }

  sendChatCompletion(apiKey: string, modelId: string, messages: ChatMessage[], options?: any): Observable<any> {
    // Process messages to ensure content is a string and extract latest prompt
    let latestPrompt = '';
    const processedMessages = messages.map(message => {
      let contentString = '';
      if (Array.isArray(message.content)) {
        // Assuming content is an array of MessageContentPart
        contentString = message.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n'); // Join text parts with newline
      } else if (typeof message.content === 'string') {
        contentString = message.content;
      }

      // If this is the last message (the user's current prompt), capture its text
      if (message === messages[messages.length - 1] && message.role === 'user') {
          latestPrompt = contentString;
      }

      return {
        role: message.role,
        content: contentString, // Ensure content is a string
        // Keep other potential fields like thinking_steps if they exist on the message object
        ...(message as any).thinking_steps && { thinking_steps: (message as any).thinking_steps }
      };
    });

    // The backend /chat endpoint expects a ChatRequest body
    const body = {
      prompt: latestPrompt, // Add the missing prompt field
      messages: processedMessages, // Include the processed conversation history
      apiKey: apiKey,
      modelId: modelId,
      use_sequential_thinking: options?.sequentialThinkingEnabled ?? false, // Pass sequential thinking state
      sequential_thinking_params: options?.sequentialThinkingParams, // Pass sequential thinking params if any
      ...(options?.imageData && { imageData: options.imageData }) // Include imageData if present in options
    };

    // Call the backend endpoint for chat completion
    return this.http.post<any>(`http://localhost:8000/chat`, body); // No need for Authorization header here, backend handles it
  }
}