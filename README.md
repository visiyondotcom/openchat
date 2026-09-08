# openchat V2.0.0

<img width="1914" height="902" alt="image" src="https://github.com/user-attachments/assets/b0d69099-55cc-4851-ad3b-3e93f6883427" />

<img width="1902" height="550" alt="image" src="https://github.com/user-attachments/assets/d9e950e3-9247-4f6c-84a0-2e6675037fde" />

<img width="1905" height="881" alt="image" src="https://github.com/user-attachments/assets/de18eb65-65d2-4977-982c-7477ede807f4" />

<img width="1912" height="910" alt="image" src="https://github.com/user-attachments/assets/fc841445-0584-4cee-8d40-d997aba40f8d" />




Openchat All in One AI Video, Saas, Images, Motion Generator, Video editor, and more


Start Now Your Own Kling AI Business or OpenAI Business 

Open-source, self-hosted AI platform to launch your own AI business — Kling-style video generation, OpenAI-style chat API, multiple LLMs (Ollama/Llama), image generation, multi-user accounts, and built-in Stripe billing. White-label ready.

Open-source AI chat interface, self-hostable and built to run alongside the rest of the Visiyon platform.
Open-source, self-hosted AI chat platform — ChatGPT alternative with local LLM support (Ollama), multi-user accounts, and optional Stripe billing to run as your own SaaS. Part of the Visiyon AI suite.
Visiyon AI Selfhosted Open AI Claude Code, Claude Coding, Selfhosted Claude API, Run Your Own Claude On Your Server, Saas AI, Cursor XAI, Grok AI, Selfhosted GROK AI, Deepseek, Qwen AI, GLM 5.2 AI, KIMI 3 AI Selfhosted Platform, Anthropic Platform 🚀
Selfhosted Anthropic Fable 5 AI, Sonnet 5, Opus 5, Haiku 5 AI Selfhosted, Gemini AI Selfhosted Google AI Selfhosted Run AI on Your Pc Laptop, Smartphone, Servers A self-hosted AI assistant platform for Ubuntu Server 22.04, powered by Ollama. Next.js 15 · React 19 · TypeScript · Tailwind · Fastify · PostgreSQL · Prisma · Redis · Nginx · Docker Compose.

What's included and working right now
Full Docker Compose stack: Postgres, Redis, Ollama, SearXNG, Whisper (STT), Piper/Kokoro/Coqui XTTS-v2 (TTS), Fastify backend, Next.js frontend, Nginx reverse proxy
In-panel updates: Admin > Updates checks GitHub for new releases and applies them with one click (git pull + rebuild) via a small sidecar container — see "Updating" below. Off by default until you set UPDATE_REPO.
JWT auth: register, login, first registered user becomes admin. Session tokens expire after JWT_EXPIRES_IN (default 7 days); the frontend auto-logs-out and redirects to /login on a 401. Login, register, and password-reset-request are rate-limited (5–10 attempts / 15 min) against brute-forcing.
SSO (OIDC): optional "Continue with <provider>" login against any OpenID Connect provider (Keycloak, Authentik, Auth0, Azure AD, Google Workspace, Okta, ...); auto-hidden when not configured. The login screen renders a branded, white "Continue with Microsoft" button (with the four-color Microsoft logo) automatically when the provider name starts with "Microsoft" or "Azure" — any other provider name falls back to a plain outlined button. Configure it from Admin → Settings → Login providers (recommended — persists in the database, no redeploy needed) or via OIDC_* env vars, which any field left blank in the admin panel falls back to. To wire up Microsoft Entra ID (Azure AD), fill in on that admin page (or set as env vars):
Issuer URL:      https://login.microsoftonline.com/<tenant-id>/v2.0
Client ID:       <app registration client id>
Client secret:   <app registration client secret>
Provider name:   Microsoft
Redirect URI:    https://<your-webui-url>/api/auth/sso/callback
(create the app registration under Azure Portal → App registrations, add the redirect URI as a Web platform callback, and grant it the openid, email, profile delegated permissions)
Password reset: real SMTP email via nodemailer (works with any SMTP server, including free local ones like Mailpit) — falls back to returning the token in the API response if SMTP isn't configured, so the flow still works end-to-end in local dev
Voice: speak your message (self-hosted Whisper transcription), with real-time streaming text-to-speech that starts talking as the reply is still generating and can be interrupted mid-sentence (barge-in) — pick the TTS engine from Admin → Settings → Voice: Piper (bundled, fastest, robotic-ish), Kokoro (bundled, natural, CPU-friendly — docker compose --profile tts-kokoro up -d), Coqui XTTS-v2 (bundled, most natural local option, voice cloning, GPU recommended — docker compose --profile tts-coqui up -d), or ElevenLabs (cloud API, most human-sounding, needs an API key)
Light / dark mode: toggle in the sidebar, preference stored in localStorage, no flash-of-wrong-theme on reload
API keys: issue/revoke personal API keys from Settings; requireAuth accepts a vis_-prefixed key as a Bearer token alongside the normal JWT, so keys work on every route
Automatic detection of every model pulled into Ollama (GLM-4, Granite, Llama, Qwen, Gemma, DeepSeek, Mistral, Phi, vision models — no hardcoding)
Real token-by-token streaming chat over SSE, proxied through Nginx (buffering disabled so it streams live)
Stop generating, regenerate, multi-chat, search/rename/pin/delete chats, auto-titling
RAG / document upload: attach PDF, DOCX, TXT, MD, or CSV files to any chat. Documents are chunked, embedded (via Ollama's embeddings API), and stored in Postgres with pgvector. Retrieved chunks are injected as context and cited by source in the reply, with clickable source chips in the UI.
Prompt Library: save reusable system-prompt presets, personal or (admin-only) shared with everyone; apply one to a chat in one click and it persists on that chat
Playground: a standalone page to test any model with free sliders for temperature/top-p/context window, independent of chat history — nothing is saved server-side
Permission groups: admins can create groups with an allowlist of Ollama models and assign users to them; users with no group (or a group with an empty allowlist) keep unrestricted access
Web search: toggle live web search per message. Backed by a bundled SearXNG instance; results are fetched, formatted with numbered sources, and injected as context before the model answers
Tools / function calling: attach tools to a chat and the model can call them mid-conversation, in a multi-round loop (call a tool, get the result, answer — bounded to avoid loops). Ships with built-in safe tools (calculator via mathjs, current_datetime); admins can register additional HTTP tools against any external API, with parameter validation before the call goes out. HTTP tool execution is sandboxed: private/loopback/link-local/cloud-metadata addresses are blocked (SSRF protection), requests time out after 10s, and output is size-capped. Tool calls and their results are persisted as TOOL messages and shown in the UI with a "Used <tool>" indicator.
Image generation: optional, multi-provider, picked in Admin > Settings > Image generation. Four options: Self-hosted runs AUTOMATIC1111/stable-diffusion-webui on your own GPU(s) via the bundled sd-wrapper service (docker compose --profile selfhosted-images up -d) — tested against 2x Tesla P100; Custom points IMAGE_GEN_URL at anything else that speaks the OpenAI images API shape (LocalAI, ComfyUI's OpenAI-compatible wrapper, fal.ai); OpenAI and Stability AI use those providers' own APIs directly with their own key field. Generated images are dropped into chat history like any other reply. Off by default and hidden entirely if unconfigured.
Chat sharing: generate a public, read-only link for any chat (/share/:id) — anyone with the link can view the conversation without an account; revoke it any time. Flagged/system messages and raw tool payloads are never included in the public view.
Pipelines (moderation/hooks): admin-defined keyword/regex rules that run on every message — PRE rules can BLOCK before it reaches the model, POST rules FLAG the reply for review. No external moderation API needed.
Folders: create/rename/delete folders in the sidebar, move any chat into or out of one from its hover menu; deleting a folder keeps the chats, just unfiles them
Admin event log: DB-backed log of auth failures, SSO errors, tool/document processing failures, and pipeline blocks/flags, filterable by level and source in the admin panel
Markdown rendering, syntax-highlighted code blocks with copy, Mermaid diagrams, LaTeX (KaTeX)
Black, OpenAI-style landing page with Visiyon branding, animated hero, feature cards, models section, interactive demo, FAQ, contact, footer
Admin dashboard: user list + role management, group management with per-group model access, server/Ollama/SearXNG health, model list, pull/delete models via API, event log
Built-in platform support chat: a "Need help?" widget (bottom-right, any logged-in page) answers questions about how to use Visiyon itself — where a setting lives, what a feature does, why a model isn't showing up. Runs on this deployment's own local Ollama (no external API, no extra cost); picks whichever chat-capable model is already installed unless SUPPORT_MODEL is set. Its knowledge is a fixed doc at backend/src/lib/support-knowledge.ts — update it if you rename/add major features.
Analytics: a monitoring tab in the admin panel — messages and token usage (prompt/completion, straight from Ollama) over a 7/30/90-day window, a per-day chart, a per-model breakdown with an optional cost estimate (configure MODEL_COST_PER_1M to attach a reference $/1M-token figure — self-hosted Ollama has no real per-token cost, so this is opt-in), and a per-user table (messages, tokens, last active) for keeping an eye on who's using the platform and how
Configuration notes
Image generation now has a fully self-hosted path: enable it with docker compose --profile selfhosted-images up -d (needs an NVIDIA GPU — validated on 2x Tesla P100), then set the provider to "Self-hosted" in Admin > Settings. No API key or external service required. If you'd rather use a cloud provider — your own or for other people running this platform who don't have a GPU — pick OpenAI, Stability AI, or point "Custom" at any endpoint implementing POST {url}/v1/images/generations in the OpenAI shape.

Running the self-hosted stack (2x P100 or similar):

docker compose --profile selfhosted-images up -d sd-webui sd-wrapper
First boot downloads a base SD checkpoint into the sd_models_data volume, which can take a while. Once sd-webui is healthy, set provider "Self-hosted" in the admin panel — the wrapper URL defaults to http://sd-wrapper:8000 in-cluster, so nothing else to configure. Optional env vars: SD_MODEL (checkpoint filename to force) and WRAPPER_API_KEY (require a bearer token on the wrapper's own endpoint, useful if you expose it beyond the internal network).

Admin logs are a plain Postgres table (Log), not a Loki/ELK pipeline — intentional, so there's no extra service to run. If you want container-level log shipping too (for infra debugging beyond app events), that still layers in fine alongside this.

None of this needs a rewrite if you want to extend further — the schema and routes were built with headroom for it.

Requirements
Ubuntu Server 22.04 (or any Linux host with Docker)
Docker Engine + Docker Compose plugin
~8GB+ RAM recommended for running 8-9B models on CPU; a GPU (with nvidia-container-toolkit) makes this much faster
1. Install Docker (if not already installed)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
2. Get the project onto your server
Copy this whole visiyon-ai/ folder to your server, e.g. via scp or git:

scp -r visiyon-ai your-user@your-server:/opt/visiyon-ai
ssh your-user@your-server
cd /opt/visiyon-ai
3. Configure environment
cp .env.example .env
nano .env   # set POSTGRES_PASSWORD and JWT_SECRET to real random values
Generate a strong secret quickly with:

openssl rand -hex 32
4. Build and start everything
docker compose up -d --build
This starts, in order-of-dependency: Postgres, Redis, Ollama, the backend (which pushes the Prisma schema to Postgres on boot), the frontend, and Nginx on port 80.

Check everything is healthy:

docker compose ps
docker compose logs -f backend
Want the Admin > System resources panel to show GPU stats? That needs the GPU attached to the backend container specifically (by default it's only attached to Ollama/sd-webui). If the backend runs on the same GPU box:

docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
GPU stats troubleshooting
If the Admin panel still shows "No GPU stats available" (or docker exec -it visiyon-backend nvidia-smi fails) after applying the override above, work through these in order — each one rules out a different layer:

1. Confirm the host itself sees the GPU(s):

nvidia-smi -L
If this fails, install/configure the NVIDIA driver on the host first — nothing below will work without it.

2. Confirm GPU passthrough into Docker works at all, independent of this project:

docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
If this fails, the host's NVIDIA Container Toolkit isn't wired up to the Docker daemon yet:

sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
Then retest this step before moving on.

3. Confirm the GPU override is actually being applied to the backend service:

docker compose -f docker-compose.yml -f docker-compose.gpu.yml config | grep -B2 -A8 "runtime\|reservations"
You should see both runtime: nvidia and a deploy.resources.reservations.devices block under backend. If you see neither, you're likely still working from an old copy of docker-compose.gpu.yml — re-copy it from this repo and retry. docker-compose.gpu.yml intentionally declares GPU access two different ways (deploy.resources.reservations.devices and the older runtime: nvidia + NVIDIA_VISIBLE_DEVICES) because which one actually takes effect depends on your Docker Compose version — keep both unless you've confirmed which one your setup needs.

4. If step 3 looks correct but nvidia-smi still fails inside the container with an error like executable file not found in $PATH, the cause is almost always the backend's base image, not the GPU passthrough itself. The NVIDIA Container Toolkit injects nvidia-smi and the driver libraries in a way that's built against glibc — it does not reliably work on musl-based images like node:*-alpine. This project's backend/Dockerfile uses node:20-bookworm-slim (Debian, glibc) specifically for this reason. If you've customized the Dockerfile to use an Alpine base, GPU stats will not work no matter how the compose file is configured — switch back to a Debian/Ubuntu-based Node image, rebuild with --no-cache, and retest:

docker compose -f docker-compose.yml -f docker-compose.gpu.yml build --no-cache backend
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d backend
docker exec -it visiyon-backend nvidia-smi
Once nvidia-smi works inside the container, the Admin panel picks it up automatically on its next poll (every few seconds) — no further restart needed.

5. Pull the models you want
docker exec -it visiyon-ollama ollama pull glm4:9b
docker exec -it visiyon-ollama ollama pull granite4:8b
# add any others: llama3.1, qwen2.5, gemma2, deepseek-r1, mistral, phi3, llava (vision), etc.

# Required for RAG (document upload / vector search) to work:
docker exec -it visiyon-ollama ollama pull nomic-embed-text
They appear in the model dropdown in the chat UI automatically — no restart needed.

6. Open it
Visit http://your-server-ip/. Register an account (the first account created becomes an admin automatically) and start chatting. The admin panel is at /admin.

How RAG (document chat) works
Click the paperclip icon in the message box → upload a PDF/DOCX/TXT/MD/CSV.
The backend extracts the text, splits it into ~1200-character overlapping chunks, embeds each chunk with nomic-embed-text, and stores the vectors in Postgres (pgvector). Status goes PENDING → PROCESSING → READY (or FAILED with a reason) — the panel polls and updates live.
Click Attach on a ready document to link it to the current chat.
From then on, every message you send in that chat first retrieves the 5 most relevant chunks (cosine similarity) from the attached documents and feeds them to the model as context — automatically, no extra steps.
Documents live in your personal library and can be attached to multiple chats; deleting a document removes its chunks and detaches it everywhere.
How web search works
Click the globe icon in the message box to toggle web search on for your next message.
On send, the backend queries the bundled SearXNG instance for your message text and pulls back the top 5 results.
Results are formatted as a numbered source list and injected as a system message ahead of the conversation — the model is asked to answer using them and cite [n] where relevant.
Toggle stays off by default and only applies per-message; if SearXNG is unreachable the request still succeeds, it just skips the search context and answers from the model's own knowledge.
First run needs SearXNG's containers to pull and initialize — give it a minute after docker compose up before toggling web search on. SearXNG's own web UI is reachable at /searxng/ if you want to tune engines directly (see searxng/settings.yml).
Updating
Manual, from the command line — always works, no setup required:

git pull   # or copy new files over
docker compose up -d --build
Or from the admin panel. Admin > Updates can check for new releases and apply them with one click, so people running your fork of this platform don't need shell access to their server to stay current:

It works by comparing the running APP_VERSION against the latest GitHub release of the repo you set in UPDATE_REPO (e.g. UPDATE_REPO=yourname/your-fork in .env). Leave UPDATE_REPO unset and the Updates page just says updates aren't configured — nothing else changes.
Applying an update is handled by a small updater sidecar container (see updater/ and the updater service in docker-compose.yml) that has the host's Docker socket and this repo's checkout mounted in. It runs git fetch
git reset --hard origin/<branch> + docker compose up -d --build and streams progress back to the admin panel. UPDATE_BRANCH controls which branch it pulls (default main).
Only that sidecar gets Docker/host access — the main backend never does. If you'd rather not offer self-service updates at all, comment the updater service out of docker-compose.yml and leave UPDATE_REPO unset.
Bump APP_VERSION in your .env (or the environment your release process sets) each time you cut a new release/tag, so the version shown in the sidebar and the update check stay accurate.
Local development (without Docker)
# Backend
cd backend
npm install
npx prisma generate
DATABASE_URL=postgresql://visiyon:visiyon@localhost:5432/visiyon \
REDIS_URL=redis://localhost:6379 \
OLLAMA_URL=http://localhost:11434 \
JWT_SECRET=dev_secret \
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev
You'll need Postgres, Redis and Ollama running locally too (or point DATABASE_URL / REDIS_URL / OLLAMA_URL at remote instances).

Project structure
visiyon-ai/
├── docker-compose.yml
├── .env.example
├── nginx/nginx.conf
├── backend/            # Fastify API: auth, chats, models, admin
│   ├── prisma/schema.prisma
│   └── src/
└── frontend/           # Next.js 15 App Router
    ├── app/             # landing page, /chat, /login, /register, /admin
    ├── components/
    └── lib/             # API client + zustand chat store
