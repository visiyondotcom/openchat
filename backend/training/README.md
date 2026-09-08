# Model training (Admin > Training)

Lets an admin upload a JSONL dataset and LoRA-finetune one of the
already-installed Ollama models on it, then automatically register the
result back into Ollama so it shows up in the normal model picker.

## Why this needs extra setup

Ollama only serves quantized **GGUF** files — you can't fine-tune those
directly. So a training job:

1. Resolves the Ollama tag you picked (e.g. `llama3.1:8b`) to its
   full-precision Hugging Face base repo (`backend/src/lib/model-catalog.ts`
   → `hfRepo`).
2. Runs `train_lora.py`, which downloads that base model, LoRA-finetunes
   it on your dataset, merges the adapter, and converts the merged model
   to GGUF with llama.cpp's converter.
3. Runs `ollama create` to register the resulting GGUF under a new tag.

Steps 1–2 need a GPU with enough VRAM for the base model you pick, plus
Python ML packages that aren't part of the normal Node backend image.

## Enabling it

Inside the **backend** container/host (wherever `npm start` runs):

```bash
pip install -r backend/training/requirements.txt
```

Then clone llama.cpp somewhere and point `LLAMA_CPP_DIR` at it (env var
on the backend service):

```bash
git clone https://github.com/ggerganov/llama.cpp /opt/llama.cpp
# backend env:
LLAMA_CPP_DIR=/opt/llama.cpp
```

If any Hugging Face repos you plan to train against are gated
(e.g. Meta's Llama models), also set `HF_TOKEN` on the backend service —
`transformers` reads it automatically.

## Config

| Env var | Default | Purpose |
|---|---|---|
| `TRAINING_DATA_DIR` | `/data/training/datasets` | Where uploaded datasets are stored |
| `TRAINING_OUTPUT_DIR` | `/data/training/output` | Adapters / merged weights / GGUF per job |
| `TRAINING_PYTHON_BIN` | `python3` | Interpreter used to run `train_lora.py` |
| `TRAINING_DATASET_MAX_MB` | `200` | Max JSONL upload size |
| `LLAMA_CPP_DIR` | — | Path to a llama.cpp checkout (for GGUF conversion) |
| `HF_TOKEN` | — | Needed for gated Hugging Face repos |

Mount `TRAINING_DATA_DIR` / `TRAINING_OUTPUT_DIR` as a persistent volume
in production — datasets and job outputs live there, not in Postgres
(only metadata does).

## Dataset format

One JSON object per line (`.jsonl`), either:

```jsonl
{"prompt": "What is the capital of France?", "completion": "Paris."}
{"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```

## Without GPU/setup

The admin panel still works without any of this installed — dataset
upload/validation and the job queue don't need Python at all. A job will
simply fail at the `TRAINING` stage with a clear error in its log if
`torch`/`peft`/etc. aren't installed, or at `CONVERTING` if llama.cpp
isn't found.
