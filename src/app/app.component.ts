import { Component, OnInit, OnDestroy, ChangeDetectorRef, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
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
      const currentModelId = this.config().selectedModelId;
      if (!currentModelId || !models.some(m => m.id === currentModelId)) {
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

    // Clear inputs
    this.promptInput.set('');
    this.uploadedImageData.set(null);

    this.isLoading.set(true);

    // Prepare history for API (limit length if necessary)
    const apiHistory = [...this.conversationHistory()];

    this.openRouterService.sendChatCompletion(
      currentConfig.openRouterApiKey,
      currentConfig.selectedModelId,
      apiHistory,
      {
        sequentialThinkingEnabled: currentConfig.sequentialThinkingEnabled, // Pass sequential thinking state
        imageData: image // Pass uploaded image data
      }
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
      const assistantResponseText = response?.response;
      if (assistantResponseText) {
        const formattedResponseText = assistantResponseText.replace(/\n/g, '<br>');
        const responseContent: MessageContentPart[] = [{ type: 'text', text: formattedResponseText }];

        // Assuming thinking_steps might still be present at the top level if sequential thinking is enabled
        const thinkingSteps = (response as any).thinking_steps;

        this.conversationHistory.update(history => [
          ...history,
          {
            role: 'assistant',
            content: responseContent,
            thinking_steps: thinkingSteps
          }
        ]);
      } else {
        console.error('Invalid response structure or empty response:', response);
        this.conversationHistory.update(history => [
          ...history,
          { role: 'assistant', content: [{ type: 'text', text: 'Error: Received invalid or empty response structure from backend.' }] }
        ]);
        this.showNotification('Received invalid or empty response structure from backend.', 'error');
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
    return this.markdownService.toHtml(text);
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
