import requests
import asyncio
import json
import os
import sys
import logging
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import uvicorn
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from contextlib import AsyncExitStack
from mcp.types import TextContent
from sse_starlette import EventSourceResponse
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

class ChatMessage(BaseModel):
    role: str
    content: Any
    tool_call_id: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Command to start the MCP server
MCP_SERVER_CMD = "npx -y @modelcontextprotocol/server-sequential-thinking"

class MCPClient:
    def __init__(self, command: str):
        self.command = command.split()
        self.session: ClientSession | None = None
        self.exit_stack = AsyncExitStack()

    async def connect(self):
        # Define server parameters (use command/args, not shell=True initially)
        # Ensure npx is in the PATH where python runs
        server_params = StdioServerParameters(
            command="npx",
            args=["-y", "@modelcontextprotocol/server-sequential-thinking"],
            env=None # Or copy os.environ if needed
        )
        try:
            logging.info(f"Connecting to MCP server via: {server_params.command} {' '.join(server_params.args)}")
            # Enter contexts for stdio_client and ClientSession
            stdio_transport = await self.exit_stack.enter_async_context(stdio_client(server_params))
            read_stream, write_stream = stdio_transport
            self.session = await self.exit_stack.enter_async_context(ClientSession(read_stream, write_stream))

            # Perform initialization handshake
            logging.info("Initializing MCP session...")
            init_response = await self.session.initialize() # Add client info if needed
            logging.info(f"MCP session initialized successfully. Server capabilities: {init_response.capabilities}")

            # Optional: Log available tools
            tools_response = await self.session.list_tools()
            tool_names = [t.name for t in tools_response.tools]
            logging.info(f"Available tools from server: {tool_names}")

        except Exception as e:
            logging.critical(f"CRITICAL: Failed to connect or initialize MCP server: {e}", exc_info=True)
            # Ensure partial cleanup if error occurs during setup
            await self.disconnect()
            raise # Re-raise exception

    async def disconnect(self):
        logging.info("Disconnecting MCP client session...")
        await self.exit_stack.aclose()
        self.session = None
        logging.info("MCP client disconnected.")

    async def call_tool(self, tool_name: str, arguments: dict) -> any:
        if not self.session:
            raise RuntimeError("MCP client session is not active.")
        try:
            # The ClientSession likely handles mcp/request wrapping internally
            logging.info(f"Calling tool '{tool_name}' via MCP session...")
            result = await self.session.call_tool(tool_name, arguments) # result is CallToolResult
            logging.info(f"Tool '{tool_name}' executed successfully.")
            return result # Return the full CallToolResult object
        except Exception as e:
            logging.error(f"Error calling tool '{tool_name}': {e}", exc_info=True)
            raise # Re-raise or return error structure

async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Startup: Initialize and connect MCPClient
    logging.info("Application startup: Initializing MCPClient...")
    mcp_client = MCPClient(MCP_SERVER_CMD) # Re-instantiate here for lifespan scope
    app.state.mcp_client = mcp_client # Store on app state
    try:
        await mcp_client.connect()
        logging.info("Application startup complete.")
        yield # App runs here
    finally:
        # Shutdown: Disconnect MCPClient
        logging.info("Application shutdown: Disconnecting MCPClient...")
        if hasattr(app.state, 'mcp_client') and app.state.mcp_client:
             try:
                 await app.state.mcp_client.disconnect()
             except Exception as e:
                 logging.error(f"Error during MCP client disconnect: {e}", exc_info=True)
        logging.info("Application shutdown complete.")

mcp_client = MCPClient(MCP_SERVER_CMD) # Keep this for potential other uses, though lifespan is primary

app = FastAPI(title="SimpleLLM Backend", version="1.0.0", lifespan=lifespan)

origins = [
    "http://localhost:4200",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    prompt: str
    apiKey: Optional[str] = None
    modelId: Optional[str] = None
    imageData: Optional[str] = None
    messages: List[ChatMessage]

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

app.state.mcp_client = mcp_client

@app.post("/chat")
async def chat_completion(request: ChatRequest) -> EventSourceResponse:
    async def event_generator():
        print("Entering event_generator...")
        try:
            user_prompt = request.prompt
            print(">>> Retrieving API key from request...")
            api_key = request.apiKey
            print(f">>> API key retrieved: {'Exists' if api_key else 'Not Found'}")
            model_id = request.modelId
            image_data = request.imageData

            print(">>> Data extracted from request.")

            if not api_key:
                print(">>> ERROR: API key not provided in request.")
                yield json.dumps({"role": "error", "content": "Configuration error: API key not provided."})
                return # Stop the generator

            if not model_id:
                yield json.dumps({"role": "error", "content": "modelId is required for openrouter mode"})
                return

            print(f"Generating completion for prompt: {user_prompt} with model {model_id}")

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }

            print(">>> Headers prepared.")

            messages_payload = request.messages

            if image_data and messages_payload:
                last_message = messages_payload[-1]
                if last_message.role == "user":
                    if not isinstance(last_message.content, list):
                        last_message.content = [{"type": "text", "text": str(last_message.content)}]

                    last_message.content.append({"type": "image_url", "image_url": {"url": image_data}})
                else:
                    logging.warning("Last message in history is not from user, adding new user message with image.")
                    new_user_message_content = [{"type": "text", "text": user_prompt}]
                    if image_data:
                        new_user_message_content.append({"type": "image_url", "image_url": {"url": image_data}})
                    messages_payload.append({"role": "user", "content": new_user_message_content})

            # Define the sequential_thinking tool
            sequential_thinking_tool = {
                "type": "function",
                "function": {
                    "name": "sequentialthinking",
                    "description": "A detailed tool for dynamic and reflective problem-solving through thoughts. This tool helps analyze problems through a flexible thinking process that can adapt and evolve. Each thought can build on, question, or revise previous insights as understanding deepens.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "thought": {
                                "type": "string",
                                "description": "Your current thinking step"
                            },
                            "nextThoughtNeeded": {
                                "type": "boolean",
                                "description": "Whether another thought step is needed"
                            },
                            "thoughtNumber": {
                                "type": "integer",
                                "description": "Current thought number",
                                "minimum": 1
                            },
                            "totalThoughts": {
                                "type": "integer",
                                "description": "Estimated total thoughts needed",
                                "minimum": 1
                            },
                            "isRevision": {
                                "type": "boolean",
                                "description": "Whether this revises previous thinking"
                            },
                            "revisesThought": {
                                "type": "integer",
                                "description": "Which thought is being reconsidered",
                                "minimum": 1
                            },
                            "branchFromThought": {
                                "type": "integer",
                                "description": "Branching point thought number",
                                "minimum": 1
                            },
                            "branchId": {
                                "type": "string",
                                "description": "Branch identifier"
                            }
                        },
                        "required": [
                            "thought",
                            "nextThoughtNeeded",
                            "thoughtNumber",
                            "totalThoughts"
                        ]
                    }
                }
            }

            payload = {
                "model": model_id,
                "messages": [msg.model_dump() if isinstance(msg, BaseModel) else msg for msg in messages_payload],
                "tools": [sequential_thinking_tool],
                "tool_choice": "auto",
                "stream": True # Enable streaming
            }

            print(">>> Payload prepared.")

            print("Attempting API call...")
            # Initial API call with streaming enabled
            response = requests.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload, stream=True)
            print(f"API Response Status Code: {response.status_code}") # Added for debugging
            response.raise_for_status()

            # Variables to accumulate tool call data
            accumulated_tool_calls = []
            tool_call_in_progress = False
            assistant_message_with_tool_calls = None

            # Process the streaming response
            for line in response.iter_lines():
                # Skip empty or whitespace lines
                if not line or line.strip() == b'':
                    continue

                # Explicitly check for SSE data lines
                if line.startswith(b'data: '):
                    # Process SSE data
                    data_line = line[len(b'data: '):]

                    # Handle the [DONE] message
                    if data_line.strip() == b'[DONE]':
                        break

                    try:
                        chunk = json.loads(data_line)

                        # Extract content and tool calls from the chunk
                        if 'choices' in chunk and chunk['choices']:
                            delta = chunk['choices'][0].get('delta')
                            if delta:
                                if 'tool_calls' in delta:
                                    logger.info(f"Received tool_calls in stream chunk: {delta['tool_calls']}")
                                    # Accumulate tool calls
                                    if not accumulated_tool_calls:
                                        # First tool_calls chunk, initialize the list
                                        accumulated_tool_calls = delta['tool_calls']
                                    else:
                                        # Subsequent tool_calls chunks, append to existing ones
                                        for new_call in delta['tool_calls']:
                                            found = False
                                            for existing_call in accumulated_tool_calls:
                                                if existing_call.get('id') == new_call.get('id'):
                                                    # Append arguments to existing tool call
                                                    existing_call['function']['arguments'] += new_call['function']['arguments']
                                                    found = True
                                                    break
                                            if not found:
                                                # Add new tool call if ID not found (shouldn't happen for same call)
                                                accumulated_tool_calls.append(new_call)

                                    tool_call_in_progress = True
                                    # Store the assistant message containing tool_calls for the second API call
                                    if assistant_message_with_tool_calls is None:
                                         # This is the first chunk with tool_calls, start building the message
                                         assistant_message_with_tool_calls = {"role": "assistant", "tool_calls": delta.get('tool_calls', []), "content": delta.get('content', '')}
                                    else:
                                         # Append subsequent deltas to the message
                                         if 'tool_calls' in delta:
                                             # Append tool_calls deltas
                                             for new_call_delta in delta['tool_calls']:
                                                 found = False
                                                 for existing_call in assistant_message_with_tool_calls['tool_calls']:
                                                     if existing_call.get('id') == new_call_delta.get('id'):
                                                         existing_call['function']['arguments'] += new_call_delta['function']['arguments']
                                                         found = True
                                                         break
                                                 if not found:
                                                      assistant_message_with_tool_calls['tool_calls'].append(new_call_delta)
                                         if 'content' in delta:
                                             # Append content delta
                                             assistant_message_with_tool_calls['content'] += delta['content']


                                if 'content' in delta and not tool_call_in_progress:
                                    content_chunk = delta['content']
                                    # Yield the content chunk as a message if no tool call is in progress
                                    yield json.dumps({"role": "assistant", "content": content_chunk})

                    except json.JSONDecodeError as json_err:
                        # Log specific JSON decode errors for data lines
                        print(f"JSON decode error for line {line}: {json_err}")
                        continue # Continue to the next line, don't yield an error for this chunk
                    except Exception as e:
                        logger.error(f"Error processing stream chunk: {e}", exc_info=True)
                        # Yield a generic error message for other exceptions
                        yield json.dumps({"role": "error", "content": f"Error processing stream chunk: {e}"})
                else:
                    # Ignore non-SSE lines and log them
                    print(f"Ignoring non-SSE line: {line}")
                    continue # Continue to the next line

            # After the first stream processing loop finishes:
            if accumulated_tool_calls:
                print("Complete tool call received. Processing...")
                # Assuming only one tool call for simplicity based on the task
                tool_call = accumulated_tool_calls[0]
                tool_name = tool_call.get('function', {}).get('name')
                arguments_string = tool_call.get('function', {}).get('arguments')
                tool_call_id = tool_call.get('id')

                if tool_name and arguments_string and tool_call_id:
                    try:
                        parsed_args = json.loads(arguments_string)
                        print(f"Invoking MCP tool '{tool_name}' with args: {parsed_args}")

                        # Ensure mcp_client is accessible (from app.state in lifespan)
                        mcp_client = app.state.mcp_client
                        if not mcp_client:
                             raise RuntimeError("MCP client not initialized.")

                        tool_response_result = await mcp_client.call_tool(tool_name, parsed_args)
                        # Extract the actual result content from the CallToolResult object
                        tool_response_content = tool_response_result.content

                        print(f"MCP tool '{tool_name}' response: {tool_response_content}")

                        # Construct the tool role message
                        tool_message = {
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": tool_response_content[0].text
                        }

                        # Append original assistant message and tool message to messages for the next call
                        messages_for_next_call = [msg.model_dump() if isinstance(msg, BaseModel) else msg for msg in request.messages]
                        if assistant_message_with_tool_calls:
                             messages_for_next_call.append(assistant_message_with_tool_calls)
                        messages_for_next_call.append(tool_message)

                        # Check if the tool response indicates more thoughts are needed
                        next_thought_needed = False
                        try:
                            tool_response_json = json.loads(tool_response_content[0].text)
                            next_thought_needed = tool_response_json.get("nextThoughtNeeded", False)
                            print(f"Tool response indicates nextThoughtNeeded: {next_thought_needed}")
                        except json.JSONDecodeError:
                            print("Tool response is not valid JSON, assuming no more thoughts needed.")
                            next_thought_needed = False

                        iteration_count = 0
                        max_iterations = 10 # Safeguard to prevent infinite loops

                        # Start the iterative loop for sequential thinking
                        while next_thought_needed and iteration_count < max_iterations:
                            iteration_count += 1
                            print(f"Starting iteration {iteration_count} for sequential thinking.")

                            # Prepare payload for the next API call
                            payload_next_call = {
                                "model": model_id,
                                "messages": messages_for_next_call,
                                "tools": [sequential_thinking_tool], # Include the tool definition again
                                "tool_choice": "auto",
                                "stream": True # Enable streaming
                            }

                            print(f">>> Payload for iteration {iteration_count} API call: {payload_next_call}")
                            print(f"Making API call {iteration_count} with tool results...")
                            response_next_call = requests.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload_next_call, stream=True)
                            print(f"API Response Status Code for iteration {iteration_count}: {response_next_call.status_code}")
                            response_next_call.raise_for_status()

                            # Variables to accumulate tool call data for the current iteration
                            accumulated_tool_calls_iter = []
                            tool_call_in_progress_iter = False
                            assistant_message_with_tool_calls_iter = None
                            final_text_content = "" # To capture final text if loop terminates

                            # Process the streaming response from the current iteration's call
                            for line_iter in response_next_call.iter_lines():
                                print(f">>> Iteration {iteration_count} stream raw line: {line_iter}")
                                if not line_iter or line_iter.strip() == b'':
                                    continue

                                if line_iter.startswith(b'data: '):
                                    data_line_iter = line_iter[len(b'data: '):]
                                    print(f">>> Iteration {iteration_count} stream decoded data: {data_line_iter}")

                                    if data_line_iter.strip() == b'[DONE]':
                                        break

                                    try:
                                        chunk_iter = json.loads(data_line_iter)
                                        if 'choices' in chunk_iter and chunk_iter['choices']:
                                            delta_iter = chunk_iter['choices'][0].get('delta')
                                            if delta_iter:
                                                if 'tool_calls' in delta_iter:
                                                    logger.info(f"Received tool_calls in iteration {iteration_count} stream chunk: {delta_iter['tool_calls']}")
                                                    # Accumulate tool calls for the current iteration
                                                    if not accumulated_tool_calls_iter:
                                                        accumulated_tool_calls_iter = delta_iter['tool_calls']
                                                    else:
                                                        for new_call_iter in delta_iter['tool_calls']:
                                                            found_iter = False
                                                            for existing_call_iter in accumulated_tool_calls_iter:
                                                                if existing_call_iter.get('id') == new_call_iter.get('id'):
                                                                    existing_call_iter['function']['arguments'] += new_call_iter['function']['arguments']
                                                                    found_iter = True
                                                                    break
                                                            if not found_iter:
                                                                accumulated_tool_calls_iter.append(new_call_iter)

                                                    tool_call_in_progress_iter = True
                                                    if assistant_message_with_tool_calls_iter is None:
                                                         assistant_message_with_tool_calls_iter = {"role": "assistant", "tool_calls": delta_iter.get('tool_calls', []), "content": delta_iter.get('content', '')}
                                                    else:
                                                         if 'tool_calls' in delta_iter:
                                                             for new_call_delta_iter in delta_iter['tool_calls']:
                                                                 found_iter = False
                                                                 for existing_call_iter in assistant_message_with_tool_calls_iter['tool_calls']:
                                                                     if existing_call_iter.get('id') == new_call_delta_iter.get('id'):
                                                                         existing_call_iter['function']['arguments'] += new_call_delta_iter['function']['arguments']
                                                                         found_iter = True
                                                                         break
                                                                 if not found_iter:
                                                                      assistant_message_with_tool_calls_iter['tool_calls'].append(new_call_delta_iter)
                                                         if 'content' in delta_iter:
                                                             assistant_message_with_tool_calls_iter['content'] += delta_iter['content']


                                                if 'content' in delta_iter and not tool_call_in_progress_iter:
                                                    content_chunk_iter = delta_iter['content']
                                                    final_text_content += content_chunk_iter # Accumulate final text
                                                    # Yield content from the current iteration if it's not a tool call
                                                    yield json.dumps({"role": "assistant", "content": content_chunk_iter})

                                    except json.JSONDecodeError as json_err_iter:
                                        print(f"JSON decode error for iteration {iteration_count} stream line {line_iter}: {json_err_iter}")
                                        continue
                                    except Exception as e_iter:
                                        logger.error(f"Error processing iteration {iteration_count} stream chunk: {e_iter}", exc_info=True)
                                        yield json.dumps({"role": "error", "content": f"Error processing iteration {iteration_count} stream chunk: {e_iter}"})
                                else:
                                    print(f"Ignoring non-SSE line in iteration {iteration_count} stream: {line_iter}")
                                    continue

                            # After processing the stream for the current iteration:
                            if accumulated_tool_calls_iter:
                                print(f"Complete tool call received in iteration {iteration_count}. Processing...")
                                tool_call_iter = accumulated_tool_calls_iter[0]
                                tool_name_iter = tool_call_iter.get('function', {}).get('name')
                                arguments_string_iter = tool_call_iter.get('function', {}).get('arguments')
                                tool_call_id_iter = tool_call_iter.get('id')

                                if tool_name_iter and arguments_string_iter and tool_call_id_iter:
                                    try:
                                        parsed_args_iter = json.loads(arguments_string_iter)
                                        print(f"Invoking MCP tool '{tool_name_iter}' with args: {parsed_args_iter}")

                                        # Yield message indicating tool call start
                                        yield f"{json.dumps({'type': 'tool_call_start', 'tool_name': tool_name_iter, 'arguments': parsed_args_iter})}\n\n"
                                        await asyncio.sleep(0.01) # Small delay to ensure message is sent

                                        tool_response_result_iter = await mcp_client.call_tool(tool_name_iter, parsed_args_iter)
                                        tool_response_content_iter = tool_response_result_iter.content

                                        # Yield message indicating tool call response
                                        yield f"{json.dumps({'type': 'tool_call_response', 'tool_name': tool_name_iter, 'response': tool_response_content_iter[0].text})}\n\n"
                                        await asyncio.sleep(0.01) # Small delay to ensure message is sent

                                        print(f"MCP tool '{tool_name_iter}' response: {tool_response_content_iter}")

                                        tool_message_iter = {
                                            "role": "tool",
                                            "tool_call_id": tool_call_id_iter,
                                            "content": tool_response_content_iter[0].text
                                        }

                                        # Append assistant message and tool message for the next iteration
                                        messages_for_next_call.append(assistant_message_with_tool_calls_iter)
                                        messages_for_next_call.append(tool_message_iter)

                                        # Check if the tool response indicates more thoughts are needed for the next iteration
                                        try:
                                            tool_response_json_iter = json.loads(tool_response_content_iter[0].text)
                                            next_thought_needed = tool_response_json_iter.get("nextThoughtNeeded", False)
                                            print(f"Tool response indicates nextThoughtNeeded for next iteration: {next_thought_needed}")
                                        except json.JSONDecodeError:
                                            print("Tool response is not valid JSON, assuming no more thoughts needed for next iteration.")
                                            next_thought_needed = False

                                    except json.JSONDecodeError as e_iter:
                                        print(f"Error parsing tool call arguments in iteration {iteration_count}: {e_iter}")
                                        yield json.dumps({"role": "error", "content": f"Error parsing tool call arguments in iteration {iteration_count}: {e_iter}"})
                                        next_thought_needed = False # Stop loop on error
                                    except Exception as e_iter:
                                        print(f"Error processing tool call in iteration {iteration_count}: {e_iter}")
                                        yield json.dumps({"role": "error", "content": f"Error processing tool call in iteration {iteration_count}: {e_iter}"})
                                        next_thought_needed = False # Stop loop on error
                                else:
                                    print(f"No complete tool call received in iteration {iteration_count}. Loop will terminate.")
                                    next_thought_needed = False # Stop loop if no tool call

                            else:
                                print(f"No complete tool call received in iteration {iteration_count}. Loop will terminate.")
                                next_thought_needed = False # Stop loop if no tool call

                        # After the while loop finishes
                        if iteration_count >= max_iterations:
                            print(f"Maximum iterations ({max_iterations}) reached. Terminating sequential thinking loop.")
                            yield json.dumps({"role": "error", "content": f"Maximum iterations ({max_iterations}) reached for sequential thinking."})

                        # If the loop terminated because next_thought_needed was false, make a final API call for text completion
                        if not next_thought_needed:
                            print("Sequential thinking complete. Requesting final text completion.")
                            # Prepare payload for the final text completion call
                            payload_final_call = {
                                "model": model_id,
                                "messages": messages_for_next_call, # Use the accumulated messages
                                # Do NOT include the 'tools' parameter or set tool_choice to 'none'
                                "stream": True # Enable streaming
                            }

                            print(">>> Payload for final text completion API call:", payload_final_call)
                            print("Making final API call for text completion...")
                            response_final_call = requests.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload_final_call, stream=True)
                            print(f"API Response Status Code for final call: {response_final_call.status_code}")
                            response_final_call.raise_for_status()

                            # Process the streaming response from the final call
                            for line_final in response_final_call.iter_lines():
                                if not line_final or line_final.strip() == b'':
                                    continue

                                if line_final.startswith(b'data: '):
                                    data_line_final = line_final[len(b'data: '):]

                                    if data_line_final.strip() == b'[DONE]':
                                        break

                                    try:
                                        chunk_final = json.loads(data_line_final)
                                        if 'choices' in chunk_final and chunk_final['choices']:
                                            delta_final = chunk_final['choices'][0].get('delta')
                                            if delta_final and 'content' in delta_final:
                                                content_chunk_final = delta_final['content']
                                                # Yield the final content chunk as a message
                                                yield json.dumps({"role": "assistant", "content": content_chunk_final})

                                    except json.JSONDecodeError as json_err_final:
                                        print(f"JSON decode error for final stream line {line_final}: {json_err_final}")
                                        continue
                                    except Exception as e_final:
                                        logger.error(f"Error processing final stream chunk: {e_final}", exc_info=True)
                                        yield json.dumps({"role": "error", "content": f"Error processing final stream chunk: {e_final}"})
                                else:
                                    print(f"Ignoring non-SSE line in final stream: {line_final}")
                                    continue

                    except json.JSONDecodeError as e:
                        print(f"Error parsing tool call arguments: {e}")
                        yield json.dumps({"role": "error", "content": f"Error parsing tool call arguments: {e}"})
                    except Exception as e:
                        print(f"Error processing tool call: {e}")
                        yield json.dumps({"role": "error", "content": f"Error processing tool call: {e}"})
            else:
                print("No complete tool call received in the first stream.")
                # If no tool call, the content was already yielded in the first loop.
                pass


        except requests.exceptions.RequestException as e:
            print(f"Error during API request: {e}") # Added for debugging
            yield json.dumps({"role": "error", "content": f"Error during API request: {e}"}) # Added for frontend
        except Exception as e:
            print(f"Error during chat completion: {e}", file=sys.stderr)
            yield json.dumps({"role": "error", "content": str(e)})

    return EventSourceResponse(event_generator())

class ApiKeyRequest(BaseModel):
    api_key: str

@app.get('/api/get_models', response_model=List[ModelInfo])
async def get_models(authorization: str = Header(...)):
    try:
        api_key = authorization.split(" ")[1]

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