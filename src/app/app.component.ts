import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common'; // Import CommonModule for ngIf, ngFor, etc.
import { FormsModule, ReactiveFormsModule, FormControl } from '@angular/forms'; // Import FormsModule and ReactiveFormsModule for ngModel and FormControl
import { HttpClient, HttpHeaders } from '@angular/common/http'; // Import HttpClient and HttpHeaders
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Observable, startWith, map } from 'rxjs';
import { FormatCostPipe } from './pipes/format-cost.pipe';


export interface Model {
  id: string;
  name: string;
  context_length?: number;
  pricing?: {
    prompt: number | null;
    completion: number | null;
  };
  input_modalities?: string[];
}

@Component({
  selector: 'app-root',
  standalone: true, // Assuming a standalone component based on the original structure
  imports: [CommonModule, FormsModule, ReactiveFormsModule, MatSelectModule, MatFormFieldModule, MatInputModule, FormatCostPipe], // Add FormsModule and ReactiveFormsModule here
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  title = 'angular-app';

  private backendUrl = 'http://localhost:8000'; // Backend base URL

  allModels: Model[] = []; // Store all fetched models
  filteredModels: Model[] = []; // Store filtered models for the dropdown
  modelCapabilities: { [key: string]: string[] } = {}; // Storage for model capabilities
  uploadedImageData: string | null = null; // Storage for uploaded image data (base64)
  conversationHistory: ChatMessage[] = []; // Store conversation history
  promptInput: string = ''; // Model for the prompt input field
  apiKeyInput: string = ''; // Model for the API key input field
  modelSelector: string = ''; // Model for the selected model ID
  modelFilterCtrl = new FormControl(''); // FormControl for the model filter input
  settingsPanelOpen: boolean = false; // State for the settings panel

  sequentialThinkingEnabled: boolean = false; // State for the Sequential Thinking toggle
  sequentialThinkingStatus: string = 'unknown'; // State for the Sequential Thinking server status

  constructor(private http: HttpClient) {
    // Existing constructor code (if any)
  }

  ngOnInit(): void {
    // Fetch model capabilities on page load
    const apiKey = localStorage.getItem('openRouterApiKey'); // Get API key from localStorage
    if (apiKey) {
      this.apiKeyInput = apiKey; // Populate API key input if saved
      this.fetchOpenRouterModels(apiKey); // Fetch models if API key is available
    } else {
      console.log('No API key found in localStorage. Models will not be fetched automatically.');
    }

    // Initialize filteredModels and subscribe to filter changes
    this.modelFilterCtrl.valueChanges.pipe(
      startWith(''),
      map(value => this._filterModels(value || ''))
    ).subscribe(filteredModels => {
      this.filteredModels = filteredModels;
    });

    // Fetch initial Sequential Thinking server status
    this.fetchSequentialThinkingStatus();

    // Load Sequential Thinking preference from localStorage
    const savedSequentialThinkingEnabled = localStorage.getItem('sequentialThinkingEnabled');
    if (savedSequentialThinkingEnabled !== null) {
      this.sequentialThinkingEnabled = JSON.parse(savedSequentialThinkingEnabled);
    }
  }

  fetchSequentialThinkingStatus(): void {
    this.http.get<any>(`${this.backendUrl}/api/mcp/sequential-thinking/status`).subscribe({
      next: (response) => {
        this.sequentialThinkingStatus = response.status;
        // Optionally, update sequentialThinkingEnabled based on server's enabled status
        // if the backend is the source of truth for initial state.
        // For now, we rely on localStorage for user preference.
      },
      error: (error) => {
        console.error('Error fetching Sequential Thinking status:', error);
        this.sequentialThinkingStatus = 'error';
      }
    });
  }

  onSequentialThinkingToggleChange(): void {
    localStorage.setItem('sequentialThinkingEnabled', JSON.stringify(this.sequentialThinkingEnabled));
  }

  private _filterModels(value: string): Model[] {
    const filterValue = value.toLowerCase();
    return this.allModels.filter(model => model.name.toLowerCase().includes(filterValue));
  }


  public formatMarkdown(text: string): string {
    if (!text) {
      return '';
    }

    let formattedText = text;

    // Convert **bold** to <strong>bold</strong>
    formattedText = formattedText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Convert *italic* or _italic_ to <em>italic</em>
    formattedText = formattedText.replace(/\*(.*?)\*/g, '<em>$1</em>');
    formattedText = formattedText.replace(/_(.*?)_/g, '<em>$1</em>');

    // Convert ~~strikethrough~~ to <del>strikethrough</del>
    formattedText = formattedText.replace(/~~(.*?)~~/g, '<del>$1</del>');

    // Convert `code` to <code>code</code>
    formattedText = formattedText.replace(/`(.*?)`/g, '<code>$1</code>');

    // Convert ```code block``` to <pre><code>code block</code></pre>
    formattedText = formattedText.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // Handle lists (*, -, + followed by a space)
    const lines = formattedText.split('\n');
    let inList = false;
    let formattedLines: string[] = [];

    for (const line of lines) {
      const listItemMatch = line.match(/^[\*\-\+]\s(.*)$/);
      if (listItemMatch) {
        if (!inList) {
          formattedLines.push('<ul>');
          inList = true;
        }
        formattedLines.push(`<li>${listItemMatch[1]}</li>`);
      } else {
        if (inList) {
          formattedLines.push('</ul>');
          inList = false;
        }
        formattedLines.push(line);
      }
    }

    if (inList) {
      formattedLines.push('</ul>');
    }

    formattedText = formattedLines.join('\n');

    // Convert newlines to <br> for display outside of pre blocks
    formattedText = formattedText.replace(/(?![^<]*?<\/pre>)\n/g, '<br>');


    return formattedText;
  }

  async onSubmit(): Promise<void> {
    const prompt = this.promptInput.trim();
    const modelId = this.modelSelector; // Get selected model ID from the dropdown
    const openRouterApiUrl = 'https://openrouter.ai/api/v1/chat/completions';

    if (!prompt && !this.uploadedImageData) {
      return; // Don't send empty prompts or no image
    }

    // Retrieve API key from localStorage
    const apiKey = localStorage.getItem('openRouterApiKey');

    if (!apiKey) {
      console.error('OpenRouter API key not found in localStorage.');
      console.error('Error: OpenRouter API key is not set. Please go to settings and save your API key.');
      return; // Stop if API key is not available
    }

    // Create user message object
    const userMessage: ChatMessage = {
      role: 'user',
      content: []
    };

    if (prompt) {
      userMessage.content.push({ type: 'text', text: prompt });
    }

    if (this.uploadedImageData) {
      userMessage.content.push({ type: 'image_url', image_url: { url: this.uploadedImageData } });
    }

    // Add user message to history
    this.conversationHistory.push(userMessage);

    this.promptInput = ''; // Clear input field
    this.uploadedImageData = null; // Clear uploaded image data after sending

    // Optional: Show loading indicator
    // this.displayMessage('...', 'model loading'); // You would style 'model loading' in CSS

    try {
      const headers = new HttpHeaders({
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      });

      // Note: The API key should ideally be handled securely (e.g., via environment variables or a backend proxy)
      // and not hardcoded directly in the frontend code.

      const requestBody: any = {
        model: modelId,
        messages: this.conversationHistory // Send the entire conversation history
      };

      // Add Sequential Thinking parameters if enabled and server is running
      if (this.sequentialThinkingEnabled && this.sequentialThinkingStatus === 'running') {
        requestBody.use_sequential_thinking = true;
        // Add sequential_thinking_params if needed based on the plan.
        // The plan mentions deriving thought, thoughtNumber from chat context,
        // but doesn't specify the exact structure or how to derive them.
        // For now, I will omit sequential_thinking_params as it's optional
        // and the backend might handle default values or derive them itself.
        // If the plan provided more details, I would add them here.
        // requestBody.sequential_thinking_params = { ... };
      }

      this.http.post(openRouterApiUrl, requestBody, { headers }).subscribe({
        next: (data: any) => {
          console.log('Received data from OpenRouter:', data); // Log the whole data object

          // Handle thinking steps if present
          if (data.thinking_steps) {
            const thinkingMessage: ChatMessage = {
              role: 'assistant', // Or a new role like 'thinking' if styled differently
              content: [{ type: 'thinking_steps', text: 'Thinking Steps:\n' + data.thinking_steps }]
            };
            this.conversationHistory.push(thinkingMessage);
          }

          // Assuming the response structure is similar to OpenAI chat completions
          const assistantMessageContent = data.choices?.[0]?.message?.content;
          console.log('Extracted response:', assistantMessageContent); // Log the extracted value
          if (assistantMessageContent) {
            // Create assistant message object
            const assistantMessage: ChatMessage = {
              role: 'assistant',
              content: [{ type: 'text', text: assistantMessageContent }]
            };
            // Add assistant message to history
            this.conversationHistory.push(assistantMessage);
          } else if (!data.thinking_steps) { // Only show error if no thinking steps either
            console.error('LLM response not found in data object:', data);
            // Optionally add an error message to the history
            this.conversationHistory.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'Error: Could not get response from model.' }]
            });
          }
        },
        error: (error) => {
          console.error('Error fetching from OpenRouter:', error);
          console.error('Error: Could not get response from model.'); // Style 'error' in CSS
        },
        complete: () => {
          // Optional: Hide loading indicator
          // removeLoadingIndicator();
        }
      });

    } catch (error) {
      console.error('Error preparing request:', error);
      console.error('Error: Could not prepare request.');
    }
  }

  // Remove the old displayMessage function as history is now managed directly
  // displayMessage(message: string, sender: string): void {
  //   this.chatHistory.push({ message, sender });
  //   // Auto-scroll to bottom - this will need to be handled after the DOM updates
  //   // This is typically done with ViewChild and a slight delay or afterViewChecked
  // }

  formatMessageContent(content: any[]): string {
    let html = '';
    for (const item of content) {
      if (item.type === 'text') {
        html += item.text;
      } else if (item.type === 'image_url') {
        // Assuming the image_url.url contains the base64 data URL
        html += `<img src="${item.image_url.url}" alt="Uploaded image" class="chat-image">`;
      } else if (item.type === 'thinking_steps') {
         html += `<pre class="thinking-steps">${item.text}</pre>`;
      }
    }

    // Apply formatting to the text content (assuming only text items need formatting)
    // This part might need refinement based on how you want to mix text and images
    // For simplicity, applying formatting to the whole resulting HTML string
    // You might want to apply formatting only to the text parts before combining
    html = this.applyTextFormatting(html);

    return html;
  }

  applyTextFormatting(text: string): string {
    let html = text;

    // Convert **Bold** to <strong>Bold</strong>
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Convert ***Emphasis*** to <strong>Emphasis</strong> (often treated as bold)
    html = html.replace(/\*\*\*(.*?)\*\*\*/g, '<strong>$1</strong>');

    // Handle bullet points (* or -)
    const lines = html.split('\n');
    let inList = false;
    let formattedLines: string[] = [];

    for (const line of lines) {
      const listItemMatch = line.match(/^[\*\-]\s(.*)$/);
      if (listItemMatch) {
        if (!inList) {
          formattedLines.push('<ul>');
          inList = true;
        }
        formattedLines.push(`<li>${listItemMatch[1]}</li>`);
      } else {
        if (inList) {
          formattedLines.push('</ul>');
          inList = false;
        }
        // Handle paragraphs and line breaks for non-list items
        formattedLines.push(line);
      }
    }

    if (inList) {
      formattedLines.push('</ul>');
    }

    html = formattedLines.join('\n');

    // Handle remaining line breaks outside of lists
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault(); // Prevent default Enter behavior
      this.onSubmit(); // Trigger the send button's click handler
    }
  }

  saveSettings(): void {
    const apiKey = this.apiKeyInput.trim();
    const modelId = this.modelSelector;

    // Save settings to localStorage
    localStorage.setItem('openRouterApiKey', apiKey);
    localStorage.setItem('openRouterModelId', modelId);

    // Update UI based on the newly selected model
    this.updateMultimodalUI(modelId);

    if (apiKey) {
      this.fetchOpenRouterModels(apiKey); // Re-fetch models if API key is saved/updated
    } else {
      console.log('API Key is empty. Models will not be fetched.');
      this.allModels = []; // Clear models if API key is removed
      this.filteredModels = []; // Clear filtered models
    }
  }

  fetchOpenRouterModels(apiKey: string): void {
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${apiKey}`
    });

    this.http.get<Model[]>(`${this.backendUrl}/api/get_models`, { headers }).subscribe({
      next: (data: Model[]) => { // Cast data to Model[]
        this.allModels = data; // Store all fetched models
        this.filteredModels = data; // Initialize filtered models with all models
        // Assuming data is an array of model objects with 'id' and 'input_modalities'
        this.modelCapabilities = {}; // Clear previous capabilities
        data.forEach(model => {
          this.modelCapabilities[model.id] = model.input_modalities || []; // Ensure it's an array
        });

        console.log('Model capabilities fetched and models stored:', this.modelCapabilities);

        // Restore selection from localStorage after populating
        const savedModelId = localStorage.getItem('openRouterModelId');
        if (savedModelId && this.allModels.find(model => model.id === savedModelId)) {
          this.modelSelector = savedModelId;
        } else if (this.allModels.length > 0) {
          // If no saved model or saved model not available, select the first one
          this.modelSelector = this.allModels[0].id;
        }

        // Display details for the initially selected model
        // Update UI based on initially selected model
        this.updateMultimodalUI(this.modelSelector);

      },
      error: (error) => {
        console.error('Fetch error:', error);
        alert('Failed to connect to backend or fetch models.');
        this.allModels = []; // Clear models on error
        this.filteredModels = []; // Clear filtered models on error
      }
    });
  }

  onModelSelectChange(): void {
    const selectedModelId = this.modelSelector;
    this.updateMultimodalUI(selectedModelId); // Update UI based on selected model
  }

  get selectedModelDetails(): Model | undefined {
    return this.allModels.find(m => m.id === this.modelSelector);
  }

  // Slide-out panel functionality
  openSettingsPanel(): void {
    this.settingsPanelOpen = true;
  }

  closeSettingsPanel(): void {
    this.settingsPanelOpen = false;
  }

  // Function to update visibility of multimodal input buttons
  updateMultimodalUI(selectedModelId: string): void {
    // This logic will be handled by ngIf in the template based on modelCapabilities
    const capabilities = this.modelCapabilities[selectedModelId];
    // You would have properties like `showImageUpload` and `showAudioUpload`
    // bound to ngIf in the template.
    // For now, we'll just log the capabilities.
    if (capabilities) {
      console.log(`Capabilities for ${selectedModelId}:`, capabilities);
    } else {
      console.warn(`Capabilities not found for model: ${selectedModelId}`);
    }
  }

  // Handle file selection (will be triggered by input change event in template)
  handleImageUpload(event: Event): void {
    const element = event.target as HTMLInputElement;
    const file = element.files ? element.files[0] : null;

    if (file) {
      console.log('Image file selected:', file);
      const reader = new FileReader();

      reader.onload = (e) => {
        this.uploadedImageData = e.target?.result as string; // Store the base64 data URL
        console.log('Image loaded as base64 (first 100 chars):', this.uploadedImageData.substring(0, 100));
        // Optional: Display a thumbnail or indicator that an image is attached
      };

      reader.onerror = (error) => {
        console.error('Error reading file:', error);
        this.uploadedImageData = null; // Clear data on error
      };

      reader.readAsDataURL(file); // Start reading the file
    } else {
      this.uploadedImageData = null; // Clear data if no file is selected
    }
    // Reset the input value so the same file can be selected again
    if (element) {
      element.value = '';
    }
  }

  clearImage(): void {
    this.uploadedImageData = null;
  }

  triggerImageFileInput(): void {
    const fileInput = document.getElementById('imageFileInput') as HTMLInputElement;
    if (fileInput) {
      fileInput.click();
    }
  }

  handlePaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            event.preventDefault();
            const reader = new FileReader();
            reader.onload = (e: ProgressEvent<FileReader>) => {
              this.uploadedImageData = e.target?.result as string;
              // Maybe trigger change detection if needed
            };
            reader.onerror = (error) => {
              console.error('Error reading pasted file:', error);
            };
            reader.readAsDataURL(file);
            break; // Handle only the first image
          }
        }
      }
    }
  }

  handleAudioUpload(event: Event): void {
    const element = event.target as HTMLInputElement;
    const file = element.files ? element.files[0] : null;

    if (file) {
      console.log('Audio file selected:', file);
      // Optional: Store file reference for later use
      // this.selectedAudioFile = file;
    }
    // Reset the input value so the same file can be selected again
    if (element) {
      element.value = '';
    }
  }
}

// Define the ChatMessage interface
interface ChatMessage {
  role: 'user' | 'assistant';
  content: Array<{ type: 'text', text: string } | { type: 'image_url', image_url: { url: string; detail?: string } } | { type: 'thinking_steps', text: string }>;
}

