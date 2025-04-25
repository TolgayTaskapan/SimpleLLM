# Plan for Rewriting AppComponent (angular-app/src/app/app.component.ts)

This plan outlines the structure and logic for a clean rewrite of the `AppComponent`, based on the inferred intent from the existing `app.component.ts` and `app.component.html`.

## 1. Goals

*   Create a stable, maintainable, and understandable `AppComponent`.
*   Implement the core chat functionality with OpenRouter integration.
*   Handle configuration (API Key, Model Selection) via a settings panel.
*   Support multimodal input (text, images) based on selected model capabilities.
*   Integrate basic Markdown formatting for assistant responses.
*   Provide clear user feedback (e.g., loading states, errors).
*   Structure the code following standard Angular best practices.

## 2. Core Interfaces

```typescript
// src/app/core/models/model.interface.ts
export interface Model {
  id: string;
  name: string;
  description?: string; // Added for clarity
  context_length?: number;
  pricing?: {
    prompt: number | string | null; // Allow string for rates like '0.00'
    completion: number | string | null;
  };
  input_modalities?: string[]; // e.g., ['text', 'image', 'audio']
  // Add other relevant fields from API if needed
}

// src/app/core/models/chat-message.interface.ts
export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }; // Add detail option

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'; // Expand roles if needed
  content: MessageContentPart[];
  thinking_steps?: Array<{ thought: string; [key: string]: any }>; // Allow flexible thinking step structure
  // Add other potential fields like 'name' for function calls if needed
}

// src/app/core/models/app-config.interface.ts
export interface AppConfig {
  openRouterApiKey: string | null;
  selectedModelId: string | null;
  sequentialThinkingEnabled: boolean;
  // Add other settings as needed
}
```

## 3. Component Structure (`app.component.ts`)

```typescript
import { Component, OnInit, OnDestroy, ChangeDetectorRef, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpClientModule } from '@angular/common/http'; // Import HttpClientModule
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'; // For loading
import { MatSlideToggleModule } from '@angular/material/slide-toggle'; // For toggles
import { MatIconModule } from '@angular/material/icon'; // For icons
import { MatButtonModule } from '@angular/material/button'; // For buttons
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar'; // For notifications
import { Subject, Observable, Subscription, catchError, finalize, map, startWith, takeUntil, throwError } from 'rxjs';

// Import Interfaces
import { Model } from './core/models/model.interface';
import { ChatMessage, MessageContentPart } from './core/models/chat-message.interface';
import { AppConfig } from './core/models/app-config.interface';

// Import Services
import { ConfigService } from './core/services/config.service';
import { OpenRouterService } from './core/services/open-router.service';
import { MarkdownService } from './core/services/markdown.service'; // Service for formatting

// Import Pipes
import { FormatCostPipe } from './pipes/format-cost.pipe';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    HttpClientModule, // Ensure HttpClientModule is imported if not using provideHttpClient
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatIconModule,
    MatButtonModule,
    MatSnackBarModule,
    FormatCostPipe,
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'], // Use styleUrls
  providers: [ConfigService, OpenRouterService, MarkdownService] // Provide services if not root-provided
})
export class AppComponent implements OnInit, OnDestroy {
  // --- Dependencies ---
  private configService = inject(ConfigService);
  private openRouterService = inject(OpenRouterService);
  private markdownService = inject(MarkdownService);
  private snackBar = inject(MatSnackBar);
  private cdr = inject(ChangeDetectorRef); // For manual change detection if needed

  // --- State Signals ---
  // Configuration
  config = signal<AppConfig>(this.configService.loadConfig());
  apiKeyInput = signal<string>(this.config().openRouterApiKey ?? ''); // Separate signal for input binding
  selectedModelIdInput = signal<string>(this.config().selectedModelId ?? ''); // Separate signal for input binding
  sequentialThinkingEnabledInput = signal<boolean>(this.config().sequentialThinkingEnabled); // Separate signal for input binding

  // Models
  allModels = signal<Model[]>([]);
  modelCapabilities = computed(() => {
    const caps: { [key: string]: string[] } = {};
    this.allModels().forEach(m => caps[m.id] = m.input_modalities || []);
    return caps;
  });
  modelFilterCtrl = new FormControl('');
  filteredModels = signal<Model[]>([]); // Derived from allModels and filter

  // Chat
  conversationHistory = signal<ChatMessage[]>([]);
  promptInput = signal<string>('');
  uploadedImageData = signal<string | null>(null);
  isLoading = signal<boolean>(false); // Loading indicator for API calls

  // UI State
  settingsPanelOpen = signal<boolean>(false);
  sequentialThinkingStatus = signal<'enabled' | 'disabled' | 'checking' | 'error'>('disabled'); // Or derive from config/API status

  // --- Computed Signals ---
  selectedModelDetails = computed(() => this.allModels().find(m => m.id === this.config().selectedModelId));
  canUploadImage = computed(() => this.modelCapabilities()[this.config().selectedModelId ?? '']?.includes('image') ?? false);
  canUploadAudio = computed(() => this.modelCapabilities()[this.config().selectedModelId ?? '']?.includes('audio') ?? false); // Placeholder

  // --- Lifecycle ---
  private destroy$ = new Subject<void>();

  constructor() {
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
    // this.setupModelFilterListener(); // If not using effect
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
    // Load conversation history from storage? (Optional)
  }

  /* // Alternative to effect if preferred
  private setupModelFilterListener(): void {
    this.modelFilterCtrl.valueChanges.pipe(
      startWith(''),
      map(value => this._filterModels(value || '')),
      takeUntil(this.destroy$)
    ).subscribe(filtered => this.filteredModels.set(filtered));
  }

  private _filterModels(value: string): Model[] {
     const filterValue = value.toLowerCase();
     return this.allModels().filter(model => model.name.toLowerCase().includes(filterValue));
  }
  */


  // --- Model Fetching ---
  private fetchModels(apiKey: string): void {
    this.isLoading.set(true);
    this.openRouterService.getModels(apiKey).pipe(
      takeUntil(this.destroy$),
      finalize(() => this.isLoading.set(false)),
      catchError((err: HttpErrorResponse) => {
        console.error('Error fetching models:', err);
        this.showNotification(`Failed to fetch models: ${err.message}`, 'error');
        this.allModels.set([]);
        return throwError(() => err);
      })
    ).subscribe(models => {
      this.allModels.set(models);
      // Set default model if current selection is invalid or not set
      const currentModelId = this.config().selectedModelId;
      if (!currentModelId || !models.some(m => m.id === currentModelId)) {
        const defaultModelId = models.length > 0 ? models[0].id : null;
        if (defaultModelId) {
            this.selectedModelIdInput.set(defaultModelId); // Update input signal
            // Persist this default selection immediately?
            this.configService.saveConfig({ ...this.config(), selectedModelId: defaultModelId });
            this.config.set(this.configService.loadConfig()); // Reload config signal
        }
      }
      this.showNotification('Models loaded successfully.', 'success');
    });
  }

  // --- Chat Logic ---
  onSubmit(): void {
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
    if (image && this.canUploadImage()) { // Check capability again
      userContent.push({ type: 'image_url', image_url: { url: image } });
    } else if (image && !this.canUploadImage()) {
        this.showNotification('Selected model does not support images. Image ignored.', 'warn');
    }

    const userMessage: ChatMessage = { role: 'user', content: userContent };
    this.conversationHistory.update(history => [...history, userMessage]);

    // Clear inputs
    this.promptInput.set('');
    this.uploadedImageData.set(null);

    this.isLoading.set(true);

    // Prepare history for API (limit length if necessary)
    const apiHistory = [...this.conversationHistory()]; // Add slicing/filtering if needed

    this.openRouterService.sendChatCompletion(
      currentConfig.openRouterApiKey,
      currentConfig.selectedModelId,
      apiHistory,
      // Add other parameters like sequentialThinkingEnabled if API supports it
    ).pipe(
      takeUntil(this.destroy$),
      finalize(() => this.isLoading.set(false)),
      catchError((err: HttpErrorResponse) => {
        console.error('Error sending message:', err);
        const errorText = `Error: ${err.error?.error?.message || err.message || 'Unknown error'}`;
        this.conversationHistory.update(history => [
          ...history,
          { role: 'assistant', content: [{ type: 'text', text: errorText }] }
        ]);
        this.showNotification('Failed to get response from model.', 'error');
        return throwError(() => err);
      })
    ).subscribe(response => {
      const assistantMessage = response.choices?.[0]?.message;
      if (assistantMessage) {
        // Ensure content is always an array
        let responseContent: MessageContentPart[] = [];
        if (typeof assistantMessage.content === 'string') {
            responseContent.push({ type: 'text', text: assistantMessage.content });
        } else if (Array.isArray(assistantMessage.content)) {
            // Assume it matches MessageContentPart structure (or adapt if needed)
            responseContent = assistantMessage.content;
        }

        const thinkingSteps = (response as any).thinking_steps; // Adjust based on actual API response

        this.conversationHistory.update(history => [
          ...history,
          {
            role: 'assistant',
            content: responseContent,
            thinking_steps: thinkingSteps // Add thinking steps if present
          }
        ]);
      } else {
        console.error('Invalid response structure:', response);
        this.conversationHistory.update(history => [
          ...history,
          { role: 'assistant', content: [{ type: 'text', text: 'Error: Received invalid response from model.' }] }
        ]);
        this.showNotification('Received invalid response structure.', 'error');
      }
    });
  }

  // --- Event Handlers ---
  onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSubmit();
    }
  }

  handlePaste(event: ClipboardEvent): void {
     if (!this.canUploadImage()) return; // Don't handle paste if model doesn't support images

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
               this.cdr.detectChanges(); // May need manual trigger
             };
             reader.onerror = (error) => {
               console.error('Error reading pasted file:', error);
               this.showNotification('Failed to read pasted image.', 'error');
             };
             reader.readAsDataURL(file);
             break; // Handle only the first image
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
    // Reset file input
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
    // Refresh input signals from current config when opening
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
    this.config.set(newConfig); // Update main config signal

    this.showNotification('Settings saved.', 'success');
    this.closeSettingsPanel();

    // Re-fetch models if API key changed or was added
    const oldApiKey = this.config().openRouterApiKey; // Get previous key from main signal
    if (newConfig.openRouterApiKey && oldApiKey !== newConfig.openRouterApiKey) {
      this.fetchModels(newConfig.openRouterApiKey);
    } else if (!newConfig.openRouterApiKey) {
        this.allModels.set([]); // Clear models if key removed
    }
  }

  onModelSelectionChange(newModelId: string): void {
      // This might be handled automatically if using [(ngModel)] with selectedModelIdInput
      // If manual handling needed:
      this.selectedModelIdInput.set(newModelId);
      // Optionally save immediately or wait for Save button
      // this.configService.saveConfig({ ...this.config(), selectedModelId: newModelId });
      // this.config.set(this.configService.loadConfig());
  }

  onSequentialThinkingToggleChange(checked: boolean): void {
      // This might be handled automatically if using [(ngModel)] with sequentialThinkingEnabledInput
      // If manual handling needed:
      this.sequentialThinkingEnabledInput.set(checked);
      // Update status indicator (needs backend check ideally)
      this.sequentialThinkingStatus.set(checked ? 'checking' : 'disabled');
      // TODO: Add backend call to verify/enable/disable sequential thinking
      // For now, just log and potentially save
      console.log('Sequential Thinking toggled:', checked);
      // Optionally save immediately or wait for Save button
      // this.configService.saveConfig({ ...this.config(), sequentialThinkingEnabled: checked });
      // this.config.set(this.configService.loadConfig());
  }

  // --- Formatting & UI Helpers ---
  formatMarkdown(text: string): string {
    return this.markdownService.toHtml(text); // Delegate to service
  }

  showNotification(message: string, panelClass: 'success' | 'error' | 'warn' | 'info' = 'info'): void {
    this.snackBar.open(message, 'Close', {
      duration: 3000,
      panelClass: [`snackbar-${panelClass}`], // Add custom CSS classes for styling
      horizontalPosition: 'center',
      verticalPosition: 'bottom',
    });
  }

  trackByMessage(index: number, message: ChatMessage): string {
      // Create a unique identifier for each message for *ngFor optimization
      // Combine role, index, and maybe a hash of the content
      return `${index}-${message.role}-${message.content.length}`;
  }
}
```

## 4. Supporting Services

*   **`ConfigService` (`src/app/core/services/config.service.ts`):**
    *   Handles loading/saving `AppConfig` from/to `localStorage`.
    *   Provides methods like `loadConfig(): AppConfig`, `saveConfig(config: AppConfig): void`.
*   **`OpenRouterService` (`src/app/core/services/open-router.service.ts`):**
    *   Encapsulates all API calls to OpenRouter (and potentially the backend proxy/wrapper if one exists).
    *   Methods:
        *   `getModels(apiKey: string): Observable<Model[]>` (Calls backend `/api/get_models` or directly to OpenRouter if backend just proxies).
        *   `sendChatCompletion(apiKey: string, modelId: string, messages: ChatMessage[], options?: any): Observable<any>` (Calls OpenRouter `/chat/completions`). Handles setting headers.
*   **`MarkdownService` (`src/app/core/services/markdown.service.ts`):**
    *   Responsible for converting Markdown text to safe HTML.
    *   Could use a library like `marked` or a simpler custom implementation.
    *   Method: `toHtml(markdown: string): string`.

## 5. Template (`app.component.html`)

*   Use signals directly in the template (`{{ signal() }}`) or bind to them (`[property]="signal()"`).
*   Use `*ngIf` based on computed signals (`canUploadImage()`, `isLoading()`).
*   Iterate over `conversationHistory()` using `*ngFor` with `trackBy`.
*   Bind inputs using `[ngModel]` and `(ngModelChange)` or `[formControl]`.
*   Use Angular Material components (`mat-select`, `mat-spinner`, `mat-slide-toggle`, `mat-snackbar`).
*   Structure remains similar to the original, but bindings updated for signals and services.
*   Add loading indicators (`mat-spinner`) conditionally based on `isLoading()`.
*   Use `mat-icon` for buttons where appropriate.

## 6. Key Logic Flows

*   **Initialization:** `ngOnInit` -> `loadInitialData` -> `configService.loadConfig` -> (if API key exists) `fetchModels`.
*   **Settings Save:** `saveSettings` button click -> update input signals -> `configService.saveConfig` -> update main `config` signal -> potentially `fetchModels` if API key changed.
*   **Message Send:** `onSubmit` button click / Enter key -> construct user message -> update `conversationHistory` -> call `openRouterService.sendChatCompletion` -> handle response/error -> update `conversationHistory`.
*   **Model Filtering:** `modelFilterCtrl` value changes -> triggers effect (or subscription) -> updates `filteredModels` signal.
*   **Image Handling:** Upload button/paste -> `handleImageUpload`/`handlePaste` -> read file -> update `uploadedImageData` signal.

## 7. Next Steps (Post-Planning)

1.  Create the service files (`config.service.ts`, `open-router.service.ts`, `markdown.service.ts`).
2.  Implement the service logic (localStorage interaction, HTTP calls, Markdown conversion).
3.  Implement the `AppComponent` based on this plan, using signals and injecting services.
4.  Update `app.component.html` to use the new signal-based properties and methods.
5.  Add CSS for styling, including snackbar classes.
6.  Ensure proper error handling and user feedback (notifications, loading states).
7.  Add unit tests for services and component logic.