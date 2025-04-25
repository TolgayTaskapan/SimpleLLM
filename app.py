import requests
import asyncio
import json
import os
import sys
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import uvicorn

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

# --- MCP Sequential Thinking Integration ---
MCP_SEQUENTIAL_THINKING_COMMAND = os.environ.get("MCP_SEQUENTIAL_THINKING_COMMAND", "npx -y @modelcontextprotocol/server-sequential-thinking")
MCP_SEQUENTIAL_THINKING_ENABLED = os.environ.get("MCP_SEQUENTIAL_THINKING_ENABLED", "true").lower() == "true"

mcp_sequential_thinking_process: Optional[asyncio.subprocess.Process] = None
mcp_sequential_thinking_status: str = "stopped" # "stopped", "starting", "running", "error", "disabled"
mcp_sequential_thinking_output_queue: asyncio.Queue = asyncio.Queue()
mcp_sequential_thinking_response_futures: Dict[str, asyncio.Future] = {}
mcp_sequential_thinking_request_counter: int = 0

async def read_mcp_output(stream: asyncio.StreamReader, queue: asyncio.Queue):
    """Reads lines from the MCP process stdout/stderr and puts them in a queue."""
    while True:
        try:
            line = await stream.readline()
            if not line:
                break
            await queue.put(line.decode().strip())
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"Error reading from MCP stream: {e}", file=sys.stderr)
            break

async def handle_mcp_responses(output_queue: asyncio.Queue):
    """Handles messages from the MCP process output queue."""
    while True:
        try:
            message = await output_queue.get()
            print(f"Received from MCP: {message}")
            try:
                response = json.loads(message)
                if "id" in response and response["id"] in mcp_sequential_thinking_response_futures:
                    future = mcp_sequential_thinking_response_futures.pop(response["id"])
                    future.set_result(response)
                elif "error" in response:
                     print(f"MCP Error: {response['error']}", file=sys.stderr)
                # Handle other potential message types if needed
            except json.JSONDecodeError:
                print(f"Failed to decode JSON from MCP: {message}", file=sys.stderr)
            except Exception as e:
                print(f"Error processing MCP message: {e}", file=sys.stderr)
            finally:
                output_queue.task_done()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"Error in MCP response handler: {e}", file=sys.stderr)
            break

async def start_mcp_sequential_thinking():
    """Starts the sequential thinking MCP server process."""
    global mcp_sequential_thinking_process, mcp_sequential_thinking_status, mcp_sequential_thinking_output_queue

    if not MCP_SEQUENTIAL_THINKING_ENABLED:
        mcp_sequential_thinking_status = "disabled"
        print("Sequential Thinking MCP is disabled via environment variable.")
        return

    mcp_sequential_thinking_status = "starting"
    print(f"Starting Sequential Thinking MCP server with command: {MCP_SEQUENTIAL_THINKING_COMMAND}")

    try:
        # Use create_subprocess_shell to allow the system shell to resolve the command
        mcp_sequential_thinking_process = await asyncio.create_subprocess_shell(
            MCP_SEQUENTIAL_THINKING_COMMAND,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        mcp_sequential_thinking_status = "running"
        print("Sequential Thinking MCP server started successfully.")

        # Start background tasks to read stdout and stderr
        asyncio.create_task(read_mcp_output(mcp_sequential_thinking_process.stdout, mcp_sequential_thinking_output_queue))
        asyncio.create_task(read_mcp_output(mcp_sequential_thinking_process.stderr, mcp_sequential_thinking_output_queue))
        asyncio.create_task(handle_mcp_responses(mcp_sequential_thinking_output_queue))

    except FileNotFoundError:
        mcp_sequential_thinking_status = "error"
        print(f"Error: Command not found. Make sure '{command_parts[0]}' is in your PATH.", file=sys.stderr)
    except Exception as e:
        mcp_sequential_thinking_status = "error"
        print(f"Error starting Sequential Thinking MCP server: {e}", file=sys.stderr)

async def stop_mcp_sequential_thinking():
    """Stops the sequential thinking MCP server process."""
    global mcp_sequential_thinking_process, mcp_sequential_thinking_status
    if mcp_sequential_thinking_process and mcp_sequential_thinking_process.returncode is None:
        print("Stopping Sequential Thinking MCP server...")
        try:
            mcp_sequential_thinking_process.terminate()
            await asyncio.wait_for(mcp_sequential_thinking_process.wait(), timeout=5.0)
            print("Sequential Thinking MCP server stopped.")
        except asyncio.TimeoutError:
            print("Sequential Thinking MCP server did not terminate gracefully, killing...", file=sys.stderr)
            mcp_sequential_thinking_process.kill()
        except Exception as e:
            print(f"Error stopping Sequential Thinking MCP server: {e}", file=sys.stderr)
        finally:
            mcp_sequential_thinking_process = None
            mcp_sequential_thinking_status = "stopped"

async def invoke_sequential_thinking(params: Dict[str, Any]) -> Dict[str, Any]:
    """Invokes the sequential_thinking tool on the MCP server."""
    global mcp_sequential_thinking_request_counter
    if mcp_sequential_thinking_status != "running" or not mcp_sequential_thinking_process or not mcp_sequential_thinking_process.stdin:
        raise HTTPException(status_code=503, detail=f"Sequential Thinking MCP server is not running. Status: {mcp_sequential_thinking_status}")

    mcp_sequential_thinking_request_counter += 1
    request_id = f"req-{mcp_sequential_thinking_request_counter}"

    jsonrpc_request = {
        "jsonrpc": "2.0",
        "method": "sequentialthinking",
        "params": params,
        "id": request_id
    }

    try:
        future = asyncio.Future()
        mcp_sequential_thinking_response_futures[request_id] = future

        request_str = json.dumps(jsonrpc_request) + "\n"
        mcp_sequential_thinking_process.stdin.write(request_str.encode())
        await mcp_sequential_thinking_process.stdin.drain()
        print(f"Sent to MCP: {request_str.strip()}")

        response = await asyncio.wait_for(future, timeout=60.0) # Wait for response with timeout

        if "result" in response:
            return response["result"]
        elif "error" in response:
            print(f"MCP returned error for request {request_id}: {response['error']}", file=sys.stderr)
            raise HTTPException(status_code=500, detail=f"MCP tool error: {response['error'].get('message', 'Unknown error')}")
        else:
            print(f"Invalid JSON-RPC response from MCP for request {request_id}: {response}", file=sys.stderr)
            raise HTTPException(status_code=500, detail="Invalid response from MCP server")

    except asyncio.TimeoutError:
        # Clean up the future if timeout occurs
        if request_id in mcp_sequential_thinking_response_futures:
            del mcp_sequential_thinking_response_futures[request_id]
        print(f"Timeout waiting for MCP response for request {request_id}", file=sys.stderr)
        raise HTTPException(status_code=504, detail="Timeout waiting for Sequential Thinking MCP response")
    except Exception as e:
        print(f"Error invoking Sequential Thinking MCP: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Error communicating with MCP server: {e}")

@app.on_event("startup")
async def startup_event():
    """FastAPI startup event: Start the MCP server."""
    await start_mcp_sequential_thinking()

@app.on_event("shutdown")
async def shutdown_event():
    """FastAPI shutdown event: Stop the MCP server."""
    await stop_mcp_sequential_thinking()

# --- End MCP Sequential Thinking Integration ---


class ChatRequest(BaseModel):
    prompt: str
    apiKey: str = None
    modelId: str = None
    imageData: Optional[str] = None
    # --- MCP Sequential Thinking Integration ---
    use_sequential_thinking: Optional[bool] = False
    sequential_thinking_params: Optional[Dict[str, Any]] = None
    # --- End MCP Sequential Thinking Integration ---

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
        api_key = request.apiKey
        model_id = request.modelId
        image_data = request.imageData

        # --- MCP Sequential Thinking Integration ---
        thinking_output = None
        if request.use_sequential_thinking and mcp_sequential_thinking_status == "running" and request.sequential_thinking_params:
            print("Invoking Sequential Thinking MCP...")
            try:
                thinking_output = await invoke_sequential_thinking(request.sequential_thinking_params)
                print("Sequential Thinking MCP invocation successful.")
            except HTTPException as e:
                print(f"Error invoking Sequential Thinking MCP: {e.detail}", file=sys.stderr)
                # Decide how to handle this error: return it, log and continue, etc.
                # For now, we'll just log and continue with the LLM call
                pass # Or re-raise e if you want to stop the chat request

        # --- End MCP Sequential Thinking Integration ---


        if not api_key or not model_id:
            raise HTTPException(status_code=400, detail="apiKey and modelId are required for openrouter mode")

        print(f"Generating completion for prompt: {user_prompt} with model {model_id}")

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

        print(f"Generated response: {response_text}")
        response_payload = {"response": response_text}

        # --- MCP Sequential Thinking Integration ---
        if thinking_output:
            response_payload["sequential_thinking_output"] = thinking_output
        # --- End MCP Sequential Thinking Integration ---

        return response_payload

    except requests.exceptions.RequestException as e:
        print(f"Error during OpenRouter API call: {e}")
        raise HTTPException(status_code=500, detail=f"OpenRouter API error: {e}")
    except Exception as e:
        print(f"Error during chat completion: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=str(e))

# --- MCP Sequential Thinking Integration ---
@app.get('/api/mcp/sequential-thinking/status')
async def get_sequential_thinking_status():
    """Returns the current status of the Sequential Thinking MCP server."""
    return {
        "status": mcp_sequential_thinking_status,
        "enabled": MCP_SEQUENTIAL_THINKING_ENABLED
    }
# --- End MCP Sequential Thinking Integration ---


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

app.mount("/static", StaticFiles(directory="dist/angular-app", html = True), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)