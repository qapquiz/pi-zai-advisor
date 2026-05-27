# pi-zai-advisor

A [pi](https://pi.dev) extension that implements the **advisor strategy** using Zhipu AI's GLM-5 and GLM-5.1 models — a cost-effective pattern where a smaller model drives execution and escalates to a more capable model only when needed.

## How it works

```
┌─────────────┐          ┌─────────────┐
│   GLM-5     │ stuck?   │   GLM-5.1   │
│  (executor) │────────► │  (advisor)  │
│             │◄──────── │             │
│  Reads code │ guidance │  Plans,     │
│  Calls tools│          │  corrects,  │
│  Iterates   │          │  redirects  │
└─────────────┘          └─────────────┘
```

**GLM-5** (or GLM-5-Turbo) runs as the **executor** — calling tools, reading files, iterating toward a solution. When it hits a decision it can't solve, it calls the `advisor` tool. **GLM-5.1** acts as the **advisor** — it receives curated context, returns a plan, correction, or redirect. It never calls tools or produces user-facing output.

This inverts the common orchestrator→worker pattern: the smaller model drives and escalates only when needed, keeping most of the run at executor-level cost.

## Install

```bash
# From npm (once published)
pi install npm:pi-zai-advisor

# From git
pi install git:github.com/nullphase/pi-zai-advisor

# Local
pi install ./path/to/pi-zai-advisor
```

## Setup

1. **Set your ZAI API key:**

   ```bash
   export ZAI_API_KEY="your-api-key"
   ```

   Or add it to `~/.pi/agent/auth.json`.

2. **Register a ZAI provider** in `~/.pi/agent/settings.json` (or `.pi/settings.json`):

   ```json
   {
     "providers": {
       "zai": {
         "baseUrl": "https://api.z.ai/api/coding/paas/v4",
         "apiKey": "ZAI_API_KEY",
         "api": "openai-completions",
         "models": [
           {
             "id": "glm-5",
             "name": "GLM-5",
             "reasoning": false,
             "input": ["text"],
             "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
             "contextWindow": 128000,
             "maxTokens": 16384
           },
           {
             "id": "glm-5-turbo",
             "name": "GLM-5 Turbo",
             "reasoning": false,
             "input": ["text"],
             "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
             "contextWindow": 128000,
             "maxTokens": 16384
           }
         ]
       }
     }
   }
   ```

3. **Switch to a ZAI executor model:**

   ```
   /model zai/glm-5
   ```

The `advisor` tool becomes available automatically when using a ZAI executor model. The executor will consult GLM-5.1 when it needs guidance.

## Configuration

| Environment variable   | Default    | Description                        |
|------------------------|------------|------------------------------------|
| `ZAI_API_KEY`          | —          | ZAI API key (required)             |
| `ZAI_ADVISOR_MODEL`    | `glm-5.1`  | Advisor model ID                   |
| `ZAI_ADVISOR_MAX_USES` | `5`        | Max advisor calls per conversation turn |

## Commands

| Command           | Description                            |
|-------------------|----------------------------------------|
| `/advisor-status` | Show advisor configuration and usage   |

## What the advisor does

The executor calls the advisor tool when it:

- **Gets stuck** — tried an approach that isn't working, needs a fresh perspective
- **Faces complex decisions** — architectural choices, trade-offs between approaches
- **Hits a dead end** — can't figure something out after 2-3 attempts
- **Needs planning** — before starting a large refactoring or multi-step task

The advisor does **not** write code. It provides strategic guidance, corrections, and alternative approaches — then the executor continues working.

## License

MIT
