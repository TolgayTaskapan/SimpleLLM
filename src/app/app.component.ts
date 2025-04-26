import { Component, ElementRef, NgZone, OnInit, signal, WritableSignal, OnDestroy, inject, ChangeDetectorRef, computed, effect } from '@angular/core';
import { CommonModule, JsonPipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpClientModule } from '@angular/common/http';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Subject, Observable, Subscription, catchError, finalize, map, startWith, takeUntil, throwError } from 'rxjs';

// Import Interfaces
import { Model } from './core/models/model.interface';
import { AppConfig } from './core/models/app-config.interface';
import { ChatMessage, MessageContentPart } from './core/models/chat-message.interface';


// Import Services (assuming these exist in core/services)
import { ConfigService } from './core/services/config.service';
import { OpenRouterService } from './core/services/open-router.service';
import { MarkdownService } from './core/services/markdown.service';

// Import Pipes (assuming this exists in pipes)
import { FormatCostPipe } from './pipes/format-cost.pipe';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    HttpClientModule,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatIconModule,
    MatButtonModule,
    MatSnackBarModule,
    FormatCostPipe,
    JsonPipe, // Add JsonPipe for formatting JSON in template
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
  providers: [ConfigService, OpenRouterService, MarkdownService]
})
export class AppComponent implements OnInit, OnDestroy {
  // --- Dependencies ---
  private configService = inject(ConfigService);
  private openRouterService = inject(OpenRouterService);
  private markdownService = inject(MarkdownService);
  private snackBar = inject(MatSnackBar);
  private cdr = inject(ChangeDetectorRef);

  // --- State Signals ---
  // Configuration
  config = signal<AppConfig>(this.configService.loadConfig());
  apiKeyInput = signal<string>(this.config().openRouterApiKey ?? '');
  selectedModelIdInput = signal<string>(this.config().selectedModelId ?? '');
  sequentialThinkingEnabledInput = signal<boolean>(this.config().sequentialThinkingEnabled);

  // Models
  allModels = signal<Model[]>([]);
  modelCapabilities = computed(() => {
    const caps: { [key: string]: string[] } = {};
    this.allModels().forEach(m => caps[m.id] = m.input_modalities || []);
    return caps;
  });
  modelFilterCtrl = new FormControl('');
  filteredModels = signal<Model[]>([]);

  // Chat
  conversationHistory = signal<ChatMessage[]>([]);
  promptInput = signal<string>('');
  uploadedImageData = signal<string | null>(null);
  isLoading = signal<boolean>(false);

  // UI State
  settingsPanelOpen = signal<boolean>(false);
  sequentialThinkingStatus = signal<'enabled' | 'disabled' | 'checking' | 'error'>('disabled');

  // --- Computed Signals ---
  selectedModelDetails = computed(() => this.allModels().find(m => m.id === this.selectedModelIdInput()));
  canUploadImage = computed(() => this.modelCapabilities()[this.selectedModelIdInput() ?? '']?.includes('image') ?? false);
  canUploadAudio = computed(() => this.modelCapabilities()[this.selectedModelIdInput() ?? '']?.includes('audio') ?? false);

  // --- Lifecycle ---
  private destroy$ = new Subject<void>();

  constructor(
    private elementRef: ElementRef,
    private zone: NgZone
  ) {
    // Effect to save config whenever relevant input signals change (debounced?)
    effect(() => {
      const currentConfig = this.config();
      const newConfig: AppConfig = {
        openRouterApiKey: this.apiKeyInput() || null,
        selectedModelId: this.selectedModelIdInput() || null,
        sequentialThinkingEnabled: this.sequentialThinkingEnabledInput()
      };
      // Only save if changed to avoid loops if configService updates signals itself
      if (JSON.stringify(currentConfig) !== JSON.stringify(newConfig)) {
         console.log("Config changed, saving:", newConfig);
         // this.configService.saveConfig(newConfig); // Potential loop if saveConfig updates signals
         // Consider saving only in explicit saveSettings action
      }
    });

    // Effect to update filtered models based on filter input
     effect(() => {
        const filterValue = this.modelFilterCtrl.value?.toLowerCase() || '';
        const filtered = this.allModels().filter(model => model.name.toLowerCase().includes(filterValue));
        this.filteredModels.set(filtered);
     });
  }

  ngOnInit(): void {
    this.loadInitialData();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // --- Initialization ---
  private loadInitialData(): void {
    const currentConfig = this.config();
    if (currentConfig.openRouterApiKey) {
      this.fetchModels(currentConfig.openRouterApiKey);
    } else {
      this.showNotification('API Key not set. Please configure in Settings.', 'warn');
    }
  }

  // --- Model Fetching ---
  private fetchModels(apiKey: string): void {
    this.isLoading.set(true);
    (this.openRouterService.getModels(apiKey) as Observable<Model[]>).pipe(
      takeUntil(this.destroy$),
      finalize(() => this.isLoading.set(false)),
      catchError((err: HttpErrorResponse) => {
        console.error('Error fetching models:', err);
        this.showNotification(`Failed to fetch models: ${err.message}`, 'error');
        this.allModels.set([]);
        return throwError(() => err);
      })
    ).subscribe((models: Model[]) => {
      this.allModels.set(models);
      const currentModelId = this.config().selectedModelId;
      if (!currentModelId || !models.some((m: Model) => m.id === currentModelId)) {
        const defaultModelId = models.length > 0 ? models[0].id : null;
        if (defaultModelId) {
            this.selectedModelIdInput.set(defaultModelId);
            this.configService.saveConfig({ ...this.config(), selectedModelId: defaultModelId });
            this.config.set(this.configService.loadConfig());
        }
      }
      this.showNotification('Models loaded successfully.', 'success');
    });
  }

  // --- Chat Logic ---
  onSubmit(): void {

    console.log('onSubmit triggered.');
    const promptText = this.promptInput().trim();
    const image = this.uploadedImageData();
    const currentConfig = this.config();

    if (!promptText && !image) return;
    if (!currentConfig.openRouterApiKey) {
      this.showNotification('API Key is missing. Please set it in Settings.', 'error');
      return;
    }
    if (!currentConfig.selectedModelId) {
      this.showNotification('No model selected. Please choose one in Settings.', 'error');
      return;
    }

    // Construct user message
    const userContent: MessageContentPart[] = [];
    if (promptText) {
      userContent.push({ type: 'text', text: promptText });
    }
    if (image && this.canUploadImage()) {
      userContent.push({ type: 'image_url', image_url: { url: image } });
    } else if (image && !this.canUploadImage()) {
        this.showNotification('Selected model does not support images. Image ignored.', 'warn');
    }

    const userMessage: ChatMessage = { role: 'user', content: userContent };
    this.conversationHistory.update(history => [...history, userMessage]);
    console.log('User message added to history.');

    // Clear inputs
    this.promptInput.set('');
    this.uploadedImageData.set(null);

    this.isLoading.set(true);

    // Prepare history for API (limit length if necessary)
    const apiHistory = [...this.conversationHistory()];

    // Add user message to history immediately

    // Add a loading indicator message
    const loadingMessage: ChatMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '...' }],
      isLoading: true, // Custom property to indicate loading
      isPlaceholderReplaced: false // Initialize the flag
    };
    this.conversationHistory.update(history => {
      const updatedHistory = [...history, loadingMessage];
      console.log('Assistant placeholder added.');
      console.log('Conversation history after assistant placeholder:', JSON.stringify(updatedHistory));
      return updatedHistory;
    });
    this.isLoading.set(true);

    // Prepare history for API (limit length if necessary)

    // Construct SSE URL with parameters
    const baseUrl = 'http://localhost:8000/chat'; // Explicitly point to backend
    const historyParam = encodeURIComponent(JSON.stringify(apiHistory));
    const modelParam = encodeURIComponent(currentConfig.selectedModelId);
    const sequentialThinkingParam = encodeURIComponent(currentConfig.sequentialThinkingEnabled.toString());
    const imageUrlParam = image ? `&image_data=${encodeURIComponent(image)}` : ''; // Include image data if available

    const urlWithParams = `${baseUrl}?model_id=${modelParam}&sequential_thinking_enabled=${sequentialThinkingParam}&history=${historyParam}${imageUrlParam}`;

    const url = 'http://localhost:8000/chat'; // Explicitly point to backend

    // Prepare request body
    const requestBody = JSON.stringify({
      prompt: promptText, // Use promptText for the prompt field
      modelId: currentConfig.selectedModelId, // Correct casing
      imageData: image, // Correct casing
      messages: apiHistory, // Use messages instead of history
      apiKey: currentConfig.openRouterApiKey // Add the API key here
    });

    console.log('Initiating fetch call...');
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentConfig.openRouterApiKey}` // Assuming API key is needed in header
      },
      body: requestBody
    })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
      }

      console.log('Fetch response received, status:', response.status);
      // Remove the loading indicator if it exists (the stream will send the actual message)

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to get response body reader.');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let assistantMessageIndex: number | null = null; // Track the index of the assistant message being built

      // Process the stream
      console.log('Starting stream reading loop...');
      while (true) {
        console.log('Reading stream chunk...');
        const { value, done } = await reader.read();
        console.log(`Stream read result: done=${done}, value=${value ? 'present' : 'absent'}`);

        if (value) {
          const textChunk = decoder.decode(value, { stream: true });
          console.log('Processing chunk:', textChunk); // Added log

          buffer += textChunk;

          // SSE Block: Add fine-grained logging within the SSE processing block
          console.log('SSE Block: Processing buffer (before split):', buffer); // Added fine-grained log

          // Process complete SSE messages
          const messages = buffer.split('\n');
          buffer = messages.pop() || ''; // Keep the last incomplete message in the buffer

          console.log('SSE Block: Split messages count:', messages.length); // Added fine-grained log
          console.log('SSE Block: Remaining buffer (after split):', buffer); // Added fine-grained log

          for (const messageLine of messages) { // Renamed message to messageLine for clarity
            console.log('SSE Block: Processing message line:', messageLine); // Added fine-grained log
// Skip empty or whitespace-only lines
            if (!messageLine || messageLine.trim().length === 0) {
              console.log('SSE Block: Skipping empty or whitespace line.');
              continue;
            }
            if (messageLine.startsWith('data: ')) {
              console.log('SSE Block: Found data line.'); // Added fine-grained log
              const jsonString = messageLine.substring(6); // Remove 'data: '
              if (jsonString && jsonString.trim()) {
                try {
                  console.log('SSE Block: Attempting JSON parse on:', jsonString); // Added fine-grained log
                  const parsedData = JSON.parse(jsonString);
                  console.log('SSE Block: JSON parsed successfully:', JSON.stringify(parsedData)); // Added fine-grained log - Stringify for full view

                // Handle tool interaction messages
                if (parsedData.type === 'tool_call_start' && parsedData.tool_name === 'sequentialthinking') {
                  const toolCallMessage: ChatMessage = {
                    role: 'assistant', // Or a new role if needed, but assistant fits the flow
                    content: [{ type: 'text', text: '' }], // Content will be generated in template
                    messageType: 'tool_interaction',
                    toolName: parsedData.tool_name,
                    toolStep: 'call',
                    toolData: parsedData.arguments
                  };
                  this.conversationHistory.update(history => [...history, toolCallMessage]);
                  console.log('Added tool_call_start message to history.');
                  this.cdr.detectChanges();
                  this.scrollToBottom();
                } else if (parsedData.type === 'tool_call_response' && parsedData.tool_name === 'sequentialthinking') {
                   const toolResponseMessage: ChatMessage = {
                    role: 'assistant', // Or a new role if needed
                    content: [{ type: 'text', text: '' }], // Content will be generated in template
                    messageType: 'tool_interaction',
                    toolName: parsedData.tool_name,
                    toolStep: 'response',
                    toolData: parsedData.response
                  };
                  this.conversationHistory.update(history => [...history, toolResponseMessage]);
                  console.log('Added tool_call_response message to history.');
                  this.cdr.detectChanges();
                  this.scrollToBottom();
                }
                // Assuming the stream sends message objects or text chunks
                // Always append to the last message in the history (which should be the assistant's)
                else { // Only process as regular message if not a tool interaction message
                  this.conversationHistory.update(history => {
                    // Find the message with isLoading: true
                    console.log('Attempting to find assistant message with isLoading: true'); // Added log
                    const assistantMessageIndex = history.findIndex(msg => msg.role === 'assistant' && msg.isLoading);

                    if (assistantMessageIndex !== -1) {
                      const assistantMessage = history[assistantMessageIndex];
                      console.log('Found assistant message at index:', assistantMessageIndex, JSON.stringify(assistantMessage)); // Added log
                      console.log('Processing chunk:', parsedData.content); // Added log

                      if (assistantMessage.content[0].type === 'text') {
                        if (assistantMessage.isPlaceholderReplaced === false) {
                          // Replace placeholder with the first chunk
                          assistantMessage.content[0].text = parsedData.content;
                          assistantMessage.isPlaceholderReplaced = true; // Mark placeholder as replaced
                          console.log('Replaced placeholder with first chunk.'); // Added log
                        } else {
                          // Append subsequent chunks
                          assistantMessage.content[0].text += parsedData.content;
                          console.log('Appended subsequent chunk.'); // Added log
                        }
                      } else {
                        // Handle cases where the first content part is not text, if necessary.
                        console.warn('First content part of assistant message is not text, cannot append/replace.');
                      }

                      console.log('After update:', JSON.stringify(assistantMessage)); // Added log
                      this.cdr.detectChanges(); // Trigger change detection after updating state
                      this.scrollToBottom();
                    } else {
                       console.warn('Could not find or update the last assistant message placeholder.');
                    }
                    return [...history]; // Return a new array reference to trigger change detection
                  });
                }


              } catch (e) {
                console.error('SSE Block: Error parsing JSON from stream chunk:', e, 'Chunk:', jsonString); // Updated error log
                // Continue processing the stream even if one chunk fails to parse
              }
            }
            }
            else {
              // console.warn('Received non-data line from stream:', message);
            }
          }
        }

        if (done) {
          console.log('Stream finished.');
          break; // Ensure loop breaks if done is true
        }
      }
    })
    .catch((error) => {
      console.error('Fetch failed:', error);
      this.isLoading.set(false);
      // Remove the loading indicator on error/completion
      this.conversationHistory.update(history => history.filter(msg => !msg.isLoading));
      this.showNotification(`Chat stream ended or encountered an error: ${error.message}`, 'error');
      this.cdr.detectChanges();
      this.scrollToBottom();
    })
    .finally(() => {
      console.log('Fetch finally block executed.'); // Added log
      this.isLoading.set(false);
      // Ensure loading indicator is removed even if stream ends without explicit done
      this.conversationHistory.update(history => {
        console.log('Updating history in finally block to remove isLoading.'); // Added log
        let lastAssistantMessage: ChatMessage | undefined;
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].role === 'assistant') {
            lastAssistantMessage = history[i];
            break;
          }
        }
        if (lastAssistantMessage) {
          lastAssistantMessage.isLoading = false; // Set isLoading to false
        }
        return [...history];
      });
      this.cdr.detectChanges();
      this.scrollToBottom();
    });
  }

  private scrollToBottom(): void {
    try {
      // Query for the chat container element (adjust selector if needed)
      const chatContainer = this.elementRef.nativeElement.querySelector('.chat-messages-container'); // Verify this selector matches your HTML
      if (chatContainer) {
        // Use setTimeout to allow Angular to render before scrolling
        setTimeout(() => {
           chatContainer.scrollTop = chatContainer.scrollHeight;
        }, 0);
      }
    } catch (err) {
      console.error('Could not scroll to bottom:', err);
    }
  }

  // --- Event Handlers ---
  onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSubmit();
    }
  }

  handlePaste(event: ClipboardEvent): void {
     if (!this.canUploadImage()) return;

     const items = event.clipboardData?.items;
     if (items) {
       for (let i = 0; i < items.length; i++) {
         if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
           const file = items[i].getAsFile();
           if (file) {
             event.preventDefault();
             const reader = new FileReader();
             reader.onload = (e: ProgressEvent<FileReader>) => {
               this.uploadedImageData.set(e.target?.result as string);
               this.cdr.detectChanges();
             };
             reader.onerror = (error) => {
               console.error('Error reading pasted file:', error);
               this.showNotification('Failed to read pasted image.', 'error');
             };
             reader.readAsDataURL(file);
             break;
           }
         }
       }
     }
   }

  handleImageUpload(event: Event): void {
    const element = event.target as HTMLInputElement;
    const file = element.files?.[0];

    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        this.uploadedImageData.set(e.target?.result as string);
      };
      reader.onerror = (error) => {
        console.error('Error reading file:', error);
        this.uploadedImageData.set(null);
        this.showNotification('Failed to read image file.', 'error');
      };
      reader.readAsDataURL(file);
    } else {
      this.uploadedImageData.set(null);
    }
    if (element) element.value = '';
  }

  clearImage(): void {
    this.uploadedImageData.set(null);
  }

  triggerImageFileInput(): void {
    document.getElementById('imageFileInput')?.click();
  }

  // Placeholder for audio
  handleAudioUpload(event: Event): void {
    console.warn('Audio upload not implemented.');
    const element = event.target as HTMLInputElement;
    if (element) element.value = '';
    this.showNotification('Audio upload is not yet supported.', 'info');
  }

  // --- Settings Panel ---
  openSettingsPanel(): void {
    const currentConfig = this.configService.loadConfig();
    this.apiKeyInput.set(currentConfig.openRouterApiKey ?? '');
    this.selectedModelIdInput.set(currentConfig.selectedModelId ?? '');
    this.sequentialThinkingEnabledInput.set(currentConfig.sequentialThinkingEnabled);
    this.settingsPanelOpen.set(true);
  }

  closeSettingsPanel(): void {
    this.settingsPanelOpen.set(false);
  }

  saveSettings(): void {
    const newConfig: AppConfig = {
      openRouterApiKey: this.apiKeyInput().trim() || null,
      selectedModelId: this.selectedModelIdInput() || null,
      sequentialThinkingEnabled: this.sequentialThinkingEnabledInput()
    };
    this.configService.saveConfig(newConfig);
    this.config.set(newConfig);

    this.showNotification('Settings saved.', 'success');
    this.closeSettingsPanel();

    const oldApiKey = this.config().openRouterApiKey;
    if (newConfig.openRouterApiKey && oldApiKey !== newConfig.openRouterApiKey) {
      this.fetchModels(newConfig.openRouterApiKey);
    } else if (!newConfig.openRouterApiKey) {
        this.allModels.set([]);
    }
  }

  onModelSelectionChange(newModelId: string): void {
      this.selectedModelIdInput.set(newModelId);
  }

  onSequentialThinkingToggleChange(event: Event): void {
      const checked = (event.target as HTMLInputElement)?.checked ?? false;
      this.sequentialThinkingEnabledInput.set(checked);
      this.sequentialThinkingStatus.set(checked ? 'checking' : 'disabled');
      console.log('Sequential Thinking toggled:', checked);
  }

  // --- Formatting & UI Helpers ---
  formatMarkdown(text: string): string {
    return <string>this.markdownService.toHtml(text);
  }

  // Helper to safely get numeric price from potentially string/null pricing
  getNumericPrice(price: number | string | null | undefined): number {
    if (price === null || price === undefined) {
      return 0;
    }
    if (typeof price === 'string') {
      const parsed = parseFloat(price);
      return isNaN(parsed) ? 0 : parsed;
    }
    return price;
  }

  showNotification(message: string, panelClass: 'success' | 'error' | 'warn' | 'info' = 'info'): void {
    this.snackBar.open(message, 'Close', {
      duration: 3000,
      panelClass: [`snackbar-${panelClass}`],
      horizontalPosition: 'center',
      verticalPosition: 'bottom',
    });
  }

  trackByMessage(index: number, message: ChatMessage): string {
      return `${index}-${message.role}-${message.content.length}`;
  }
}
