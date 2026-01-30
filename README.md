# Project Structure

The project is a distributed system consisting of three main components:

1. **The MCP Client (The Brain/Orchestrator):**
    * **Role:** This is the application that the user interacts with (e.g., a CLI tool, a web app, or an IDE plugin).
    * **Responsibilities:**
        * Manages the conversation with the user.
        * Holds the connection to the LLM (Google Gemini).
        * Knows how to call tools but doesn't know what the tools do internally.
        * Talks to the MCP Server via gRPC.
2. **The MCP Server (The Tool Shed):**
    * **Role:** A standalone microservice (running locally or on a server).
    * **Responsibilities:**
        * Exposes specific functions ("tools") to the Client: `search_wiki`, `get_page_content`, etc.
        * Validates inputs (e.g., ensuring a search query is a string).
        * Handles the actual logic of calling the external API (Project Zomboid Wiki).
        * Returns structured data (JSON) back to the Client.
3. **The External Resource (The Knowledge Base):**
    * **Role:** The Project Zomboid Wiki (MediaWiki API).
    * **Responsibilities:**
        * Provides the raw data about the game.
        * Responds to HTTP requests from your MCP Server.

## Happy Path

This diagram illustrates the successful execution of a user request where everything works as expected.

```mermaid
sequenceDiagram
    autonumber
    box rgb(240, 248, 255) The "Host" Environment
        actor User as User
        participant MCPClient as MCP Client App<br/>(Node/Python App holding Google AI Key)
    end

    box rgb(255, 245, 255) Google Cloud
        participant Gemini as Google Gemini API<br/>(via Google AI Studio)
    end

    box rgb(230, 230, 250) The MCP Server Layer
        participant GRPCServer as MCP Server<br/>(gRPC Service)
    end

    box rgb(255, 250, 240) External Internet
        participant PZWiki as Project Zomboid Wiki<br/>(MediaWiki API)
    end

    note over User, PZWiki: **Phase 1: Initial Request & Tool Selection**
    User->>MCPClient: "How do I craft a rain collector barrel?"
    note right of MCPClient: Client has pre-loaded tool definitions<br/>from the gRPC server handshake.
    MCPClient->>Gemini: Send user prompt + MCP Tool Definitions Schema
    note over Gemini: Gemini analyzes prompt, realizes it lacks knowledge,<br/>and selects the appropriate tool based on schema.
    Gemini-->>MCPClient: Response: Stop reason="tool_use", Tool="search_wiki", Args={"query": "rain collector barrel"}

    note over User, PZWiki: **Phase 2: Executing the Tool via MCP over gRPC**
    note right of MCPClient: Client identifies the tool call needs<br/>to go to the gRPC server connection.
    MCPClient->>GRPCServer: **gRPC Request:** CallToolRequest(name="search_wiki", arguments={...})
    note left of GRPCServer: Server receives gRPC call.<br/>Internal logic translates this to MediaWiki API parameters.
    GRPCServer->>PZWiki: **HTTP GET:** https://pzwiki.net/w/api.php?action=query&list=search...
    PZWiki-->>GRPCServer: **HTTP 200 OK:** (JSON Wiki Data)
    Note left of GRPCServer: Server processes JSON and formats it according to MCP specification.
    GRPCServer-->>MCPClient: **gRPC Response:** CallToolResult(content=[{"type": "text", "text": "...wiki results..."}])

    note over User, PZWiki: **Phase 3: Final Synthesis**
    MCPClient->>Gemini: Send original prompt + Tool Result Data
    note over Gemini: Gemini synthesizes the wiki data<br/>into a natural language answer.
    Gemini-->>MCPClient: Final Answer: "To craft a rain collector barrel, you need Carpentry level 4, garbage bags, planks, and nails..."
    MCPClient->>User: Displays final answer
```

### Key Components of the Happy Path

* **Schema Handshake:** At the start (not shown in the diagram for simplicity), the Client asks the Server "What tools do you have?" and sends those definitions to Gemini. This ensures Gemini knows exactly what it can ask for.
* **Zero Hallucination (Ideally):** Because Gemini is grounded by the strict tool definitions (Zod schemas), it is much less likely to invent fake API calls.
* **Separation of Concerns:** The Client handles the "intelligence" (talking to the user and the LLM), while the Server handles the "mechanics" (fetching data). This makes your system modular and easier to maintain.

## Sad Path

There are some common causes to errors in distributed systems:

1. **Schema Validations:** LLM mistakes
2. **Transport Failures:** gRPC / Network issues
3. **Upstream Failures:** The Wiki API is down

```mermaid
sequenceDiagram
    autonumber
    
    box rgb(240, 248, 255) The "Host" Environment
        actor User as User
        participant MCPClient as MCP Client<br/>(Node/Python App)
    end

    box rgb(255, 245, 255) Google Cloud
        participant Gemini as Google Gemini API
    end

    box rgb(230, 230, 250) The MCP Server Layer
        participant GRPCServer as MCP Server<br/>(gRPC Service)
    end

    box rgb(255, 250, 240) External Internet
        participant PZWiki as Project Zomboid Wiki<br/>(MediaWiki API)
    end

    note over User, PZWiki: **Scenario A: Schema Violation (LLM Hallucination)**
    User->>MCPClient: "Find me info on the Spiffo mascot."
    MCPClient->>Gemini: Prompt + Tool Definitions
    
    note right of Gemini: Gemini tries to use the tool but<br/>guesses the wrong argument name.
    Gemini-->>MCPClient: Tool Call: search_wiki(keyword="Spiffo")
    
    note right of MCPClient: Zod Validation or gRPC Protocol Check fails.<br/>Argument should be 'query', not 'keyword'.
    MCPClient->>GRPCServer: CallToolRequest(name="search_wiki", args={"keyword": "..."})
    
    GRPCServer-->>MCPClient: **gRPC Error:** INVALID_ARGUMENT<br/>(Details: "Missing required property 'query'")
    
    note over MCPClient, Gemini: **CRITICAL STEP: The Feedback Loop**<br/>Instead of crashing, Client sends the ERROR back to Gemini.
    MCPClient->>Gemini: Tool Output: "Error: Invalid arguments. Schema requires 'query'."
    
    note right of Gemini: Gemini analyzes the error and<br/>RE-GENERATES the correct call.
    Gemini-->>MCPClient: Tool Call (Retry): search_wiki(query="Spiffo")
    MCPClient->>GRPCServer: CallToolRequest(valid) ... (Proceeds to Happy Path)

    rect rgb(255, 230, 230)
    note over User, PZWiki: **Scenario B: Upstream Dependency Failure**
    User->>MCPClient: "What is the crafting recipe for a nail bomb?"
    MCPClient->>Gemini: ... (Standard Request) ...
    Gemini-->>MCPClient: Tool Call: get_page_content(title="Nail Bomb")
    MCPClient->>GRPCServer: CallToolRequest(...)
    
    GRPCServer->>PZWiki: HTTP GET /api.php...
    PZWiki-->>GRPCServer: **HTTP 503 Service Unavailable** (or Timeout)
    
    note left of GRPCServer: Server catches the HTTP error.<br/>Translates to gRPC status code.
    GRPCServer-->>MCPClient: **gRPC Error:** UNAVAILABLE<br/>(Details: "Upstream Wiki API is timed out")
    
    note over MCPClient, User: Client decides how to handle the failure.<br/>Does NOT crash.
    MCPClient->>User: "I'm sorry, I can't access the Project Zomboid Wiki right now.<br/>It seems to be down."
    end
```

### Solutions

1. **The Self-Correction Loops (Steps 4-7):**
    * This is the most powerful part of agentic AI. When the MCP Server throws a validation error (e.g., `ZodError`), you don't show it to the user. You feed it back to the LLM as a "Tool Output."
    * Gemini is smart enough to read the error message ("property 'keyword' does not exist"), look at the schema again, and issue a new request with the correct arguments automatically.
2. **gRPC Status Mapping:**
    * You need to map HTTP errors from the Wiki to gRPC status codes in your server:
        * **HTTP 404 (Not Found):** `NOT_FOUND` (or return empty list).
        * **HTTP 500/503 (Server Error):** `UNAVAILABLE`.
        * **Network Timeout:** `DEADLINE_EXCEEDED`.
        * **Bad Zod Schema:** `INVALID_ARGUMENT`.
3. **Circuit Breaking:**
    * If the Wiki is returning 503s repeatedly, your MCP Client should probably stop asking Gemini to call tools for a few minutes to prevent cascading failures (though for a simple chat app, a simple try/catch is usually sufficient).
