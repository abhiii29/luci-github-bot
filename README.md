# LUCI GitHub Bot

An intelligent GitHub bot that automates issue handling, resource monitoring, and AI-powered task execution via Docker workers.

## 🚀 Setup Instructions

1. **Clone the repository**
   ```bash
   git clone https://github.com/abhiii29/luci-github-bot.git
   cd luci-github-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   Copy the example environment file and fill in your credentials:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and add your GitHub token, LLM API keys, and any other required configuration.

4. **Start the bot**
   ```bash
   npm start
   # or
   bash bin/start-bot.sh
   ```

## 🏗️ Architecture

```
[GitHub Webhook] --> [src/webhook.ts] --> [src/issue-handler.ts]
                                    |
                                    v
                            [src/llm.ts] (AI Processing)
                                    |
                                    v
                    [src/docker-worker.ts] (Task Execution)
                                    |
                                    v
                    [src/resource-monitor.ts] (Health & Limits)
```

## 🤖 How to Summon the Bot

- **Via @mention**: Tag `@luci-bot` in an issue or pull request comment to trigger automated responses or tasks.
- **Via Assign**: Assign the bot to an issue to automatically kick off background workflows, resource checks, or AI-assisted resolutions.