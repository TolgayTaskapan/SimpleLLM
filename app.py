import requests
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
from llama_cpp import Llama
import uvicorn
import os
import torch

app = FastAPI()

origins = [
    "http://localhost:4200",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"], # Allow all methods (GET, POST, etc.)
    allow_headers=["*"], # Allow all headers
)


# Load the GPTQ model
repo_id = "mradermacher/DeepSeek-R1-Distill-Qwen-14B-Uncensored-GGUF"
filename = "DeepSeek-R1-Distill-Qwen-14B-Uncensored.IQ4_XS.gguf"

print(f"Loading model from repo: {repo_id} with filename {filename}...")
model = Llama.from_pretrained(
    repo_id=repo_id,
    filename=filename,
    verbose=True,
    n_gpu_layers=-1  # Offload all possible layers to GPU
)
print("Model loaded.")

current_dir = os.path.dirname(os.path.abspath(__file__))

class ChatRequest(BaseModel):
    prompt: str
    mode: str
    apiKey: str = None
    modelId: str = None
    imageData: Optional[str] = None
class PricingInfo(BaseModel):
    prompt: Optional[float] = None
    completion: Optional[float] = None
    image: Optional[float] = None
    request: Optional[float] = None

class ModelInfo(BaseModel):
    id: str
    name: str
    pricing: PricingInfo
    context_length: Optional[int] = None
    input_modalities: List[str] = []

@app.post("/chat")
async def chat_completion(request: ChatRequest):
    try:
        user_prompt = request.prompt
        mode = request.mode
        api_key = request.apiKey
        model_id = request.modelId

        if mode == 'local':
            print(f"Generating completion for prompt (local mode): {user_prompt}")
            output = model.create_completion(
                user_prompt,
                max_tokens=8192,
                temperature=0.7,
                top_p=0.95,
                top_k=40,
                repeat_penalty=1.1,
                stream=False
            )
            response_text = output["choices"][0]["text"]
            print(f"Generated response (local mode): {response_text}")
            return {"response": response_text}

        elif mode == 'openrouter':
            if not api_key or not model_id:
                raise HTTPException(status_code=400, detail="apiKey and modelId are required for openrouter mode")

            # Retrieve imageData
            image_data = request.imageData

            print(f"Generating completion for prompt (openrouter mode): {user_prompt} with model {model_id}")

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }

            # Construct messages payload based on whether image data is present
            if image_data:
                messages_payload = [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": user_prompt},
                            {"type": "image_url", "image_url": {"url": image_data}}
                        ]
                    }
                ]
            else:
                messages_payload = [{"role": "user", "content": user_prompt}]

            payload = {
                "model": model_id,
                "messages": messages_payload,
                # Include other parameters like max_tokens, temperature if needed
            }

            response = requests.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload)
            response.raise_for_status() # Raise an exception for bad status codes

            response_data = response.json()
            response_text = response_data['choices'][0]['message']['content']

            print(f"Generated response (openrouter mode): {response_text}")
            return {"response": response_text}

        else:
            raise HTTPException(status_code=400, detail="Invalid mode specified. Use 'local' or 'openrouter'.")

    except requests.exceptions.RequestException as e:
        print(f"Error during OpenRouter API call: {e}")
        raise HTTPException(status_code=500, detail=f"OpenRouter API error: {e}")
    except Exception as e:
        print(f"Error during chat completion: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ApiKeyRequest(BaseModel):
    api_key: str

@app.get('/api/get_models', response_model=List[ModelInfo])
async def get_models(authorization: str = Header(...)):
    try:
        api_key = authorization.split(" ")[1] # Extract API key from "Bearer <api_key>"

        headers = {"Authorization": f"Bearer {api_key}"}
        response = requests.get('https://openrouter.ai/api/v1/models', headers=headers)

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail="Failed to fetch models from OpenRouter")

        models_data = response.json()
        processed_models = []
        for model in models_data.get('data', []):
            model_info = {
                "id": model.get('id'),
                "name": model.get('name'),
                "pricing": {
                    "prompt": float(model.get('pricing', {}).get('prompt', 0.0)),
                    "completion": float(model.get('pricing', {}).get('completion', 0.0)),
                    "image": float(model.get('pricing', {}).get('image', 0.0)),
                    "request": float(model.get('pricing', {}).get('request', 0.0))
                },
                "context_length": model.get('context_length'),
                "input_modalities": model.get('architecture', {}).get('input_modalities', [])
            }
            processed_models.append(model_info)

        return processed_models

    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=500, detail=f"Network error or failed to connect to OpenRouter: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {e}")

app.mount("/static", StaticFiles(directory="angular-app/dist/angular-app", html = True), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)