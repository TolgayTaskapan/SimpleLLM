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
    // The backend /chat endpoint expects a ChatRequest body
    const body = {
      prompt: messages.find(msg => msg.role === 'user')?.content.find(part => part.type === 'text')?.text || '', // Extract prompt text
      apiKey: apiKey,
      modelId: modelId,
      imageData: messages.find(msg => msg.role === 'user')?.content.find(part => part.type === 'image_url')?.image_url.url || null, // Extract image data
      use_sequential_thinking: options?.sequentialThinkingEnabled ?? false, // Pass sequential thinking state
      sequential_thinking_params: options?.sequentialThinkingParams // Pass sequential thinking params if any
    };

    // Call the backend endpoint for chat completion
    return this.http.post<any>(`/chat`, body); // No need for Authorization header here, backend handles it
  }
}