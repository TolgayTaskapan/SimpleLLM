import { Injectable } from '@angular/core';
import { AppConfig } from '../models/app-config.interface';

@Injectable({
  providedIn: 'root'
})
export class ConfigService {
  private readonly CONFIG_KEY = 'appConfig';

  loadConfig(): AppConfig {
    const configJson = localStorage.getItem(this.CONFIG_KEY);
    if (configJson) {
      return JSON.parse(configJson);
    }
    // Return default config if none found
    return {
      openRouterApiKey: null,
      selectedModelId: null,
      sequentialThinkingEnabled: false
    };
  }

  saveConfig(config: AppConfig): void {
    localStorage.setItem(this.CONFIG_KEY, JSON.stringify(config));
  }
}