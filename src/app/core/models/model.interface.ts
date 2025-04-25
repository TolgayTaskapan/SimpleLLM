export interface Model {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt: number | string | null;
    completion: number | string | null;
  };
  input_modalities?: string[];
}