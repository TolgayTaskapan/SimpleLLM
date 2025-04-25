import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class MarkdownService {
  toHtml(markdown: string): string {
    // Basic placeholder implementation - replace with a Markdown library like 'marked' if needed
    // Simple replacements for basic formatting
    let html = markdown.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'); // Bold
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>'); // Italic
    html = html.replace(/^- (.*)$/gm, '<li>$1</li>'); // List items (basic)
    if (html.includes('<li>')) {
      html = `<ul>\n${html}\n</ul>`;
    }
    // Add more conversions as needed

    return html;
  }
}