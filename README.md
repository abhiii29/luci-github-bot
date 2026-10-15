# LUCI GitHub Bot

A GitHub bot that automates issue handling, leverages LLMs for intelligent responses, and dynamically provisions Docker workers based on resource monitoring and webhook events.

## Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy the example environment file and fill in your credentials:
```bash
cp .env.example .env
```
Edit `.env` to add your GitHub token, LLM API keys, and other configuration values.

### 3. Start the Bot
Run the bot using the provided startup script:
```bash
bash bin/start-bot.sh
```
Alternatively, you can run it directly with TypeScript:
```bash
npx ts-node src/index.ts
```

## Architecture

```
[GitHub Webhook] --> [src/webhook.ts] --> [src/issue-handler.ts]
                                           |
                                           v
                                    [src/llm.ts] (AI Processing)
                                           |
                                           v
                            [src/resource-monitor.ts] (Check Capacity)
                                           |
                                           v
                            [src/docker-worker.ts] (Spawn/Manage Workers)
                                           |
                                           v
                                    [Docker Workers] (Execute Tasks)
```

## How to Summon the Bot

You can trigger the bot's functionality in your GitHub repositories by:
- **@mentioning** the bot in an issue or pull request comment (e.g., `@luci-bot analyze this`)
- **Assigning** the bot to an issue (e.g., `@assign luci-bot`)

The bot will automatically pick up the request, process it using the integrated LLM, and manage worker resources as needed.