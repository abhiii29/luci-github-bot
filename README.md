# LUCI GitHub Bot

A GitHub bot that automates issue handling, analyzes requests via LLM, and dynamically spawns Docker workers to execute tasks.

## 🚀 Setup Instructions

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   Copy the example environment file and fill in your credentials:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` to add your GitHub token, LLM API key, and other required configurations.

3. **Start the Bot**
   Build and run the TypeScript application:
   ```bash
   npm run build
   npm start
   ```
   Alternatively, use the provided startup script:
   ```bash
   ./bin/start-bot.sh
   ```

## 🏗️ Architecture

```
[GitHub Webhook] 
      │
      ▼
[src/webhook.ts] ──► [src/issue-handler.ts]
      │                    │
      │                    ├──► [src/llm.ts] (Analysis & Decision)
      │                    ├──► [src/resource-monitor.ts] (Check Capacity)
      │                    └──► [src/docker-worker.ts] (Spawn Container)
      │                                 │
      ▼                                 ▼
[GitHub API] ◄────────────────── [Docker Worker]
```

## 🤖 How to Summon the Bot

You can interact with LUCI in two ways:
- **@Mention**: Tag `@luci-bot` in an issue or comment to trigger a response.
- **Assign**: Assign the bot to an issue to automatically begin processing and worker allocation.

## 📜 License
MIT