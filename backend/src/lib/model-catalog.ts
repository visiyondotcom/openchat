// A curated catalog of popular Ollama-pullable models, used to power a
// "will it run" check in the admin Pull panel: before an admin types a raw
// `ollama pull` tag, we show which well-known models actually fit the GPU(s)
// this deployment currently has attached — same idea as willitrunai.com, but
// scoped to Ollama tags and this server's real, live VRAM instead of a
// generic calculator.
//
// Sizes are the on-disk GGUF download size for the *default* Ollama tag
// (almost always Q4_K_M) — that's what actually gets pulled when an admin
// types e.g. "llama3.1:8b" with no explicit quant suffix. minVramGB adds a
// ~15-20% headroom on top of the file size for KV-cache/context and
// activation memory at a modest context length, rounded up — deliberately
// conservative (closer to "comfortably fits" than "barely loads"), since
// this is meant to stop an admin from kicking off a multi-GB download that
// then OOMs on the GPU.
//
// This list is hand-maintained and won't include every model Ollama can
// pull — the raw pull box below it still works for any tag. It only needs
// to cover the popular ones people actually reach for.

export interface CatalogModel {
  tag: string; // exact `ollama pull` tag
  label: string; // human-readable name
  family: string;
  paramsB: number; // parameter count, in billions
  quant: string; // quantization of the default tag
  sizeGB: number; // approximate download size
  minVramGB: number; // approximate VRAM needed to comfortably run it
  vision?: boolean;
  description: string;
  // Full-precision Hugging Face repo id for this model's base weights —
  // what training/train_lora.py actually loads and fine-tunes, since a
  // GGUF tag pulled into Ollama is quantized and not trainable. Undefined
  // for models with no known/supported trainable base (e.g. the
  // embedding-only nomic-embed-text, or families we haven't mapped yet) —
  // lib/training.ts's admin "Train" list only offers tags that have one.
  hfRepo?: string;
}

export const MODEL_CATALOG: CatalogModel[] = [
  { tag: "llama3.2:1b", label: "Llama 3.2 1B", family: "Llama", paramsB: 1, quant: "Q8_0", sizeGB: 1.3, minVramGB: 2, hfRepo: "meta-llama/Llama-3.2-1B-Instruct", description: "Tiny and fast — good for low-VRAM cards or quick tasks." },
  { tag: "llama3.2:3b", label: "Llama 3.2 3B", family: "Llama", paramsB: 3, quant: "Q4_K_M", sizeGB: 2.0, minVramGB: 3, hfRepo: "meta-llama/Llama-3.2-3B-Instruct", description: "Small general-purpose chat model." },
  { tag: "qwen2.5:3b", label: "Qwen 2.5 3B", family: "Qwen", paramsB: 3, quant: "Q4_K_M", sizeGB: 1.9, minVramGB: 3, hfRepo: "Qwen/Qwen2.5-3B-Instruct", description: "Compact multilingual model, strong for its size." },
  { tag: "phi3.5:3.8b", label: "Phi-3.5 Mini", family: "Phi", paramsB: 3.8, quant: "Q4_K_M", sizeGB: 2.2, minVramGB: 3, hfRepo: "microsoft/Phi-3.5-mini-instruct", description: "Microsoft's small reasoning-focused model." },
  { tag: "gemma2:9b", label: "Gemma 2 9B", family: "Gemma", paramsB: 9, quant: "Q4_K_M", sizeGB: 5.4, minVramGB: 7, hfRepo: "google/gemma-2-9b-it", description: "Google's efficient mid-size open model." },
  { tag: "llama3.1:8b", label: "Llama 3.1 8B", family: "Llama", paramsB: 8, quant: "Q4_K_M", sizeGB: 4.7, minVramGB: 6, hfRepo: "meta-llama/Llama-3.1-8B-Instruct", description: "Popular general-purpose 8B chat model." },
  { tag: "qwen2.5:7b", label: "Qwen 2.5 7B", family: "Qwen", paramsB: 7, quant: "Q4_K_M", sizeGB: 4.4, minVramGB: 6, hfRepo: "Qwen/Qwen2.5-7B-Instruct", description: "Well-rounded 7B model, good at coding and multilingual tasks." },
  { tag: "mistral:7b", label: "Mistral 7B", family: "Mistral", paramsB: 7, quant: "Q4_K_M", sizeGB: 4.1, minVramGB: 6, hfRepo: "mistralai/Mistral-7B-Instruct-v0.3", description: "Fast, solid general-purpose 7B baseline." },
  { tag: "qwen2.5vl:7b", label: "Qwen 2.5 VL 7B", family: "Qwen", paramsB: 7, quant: "Q4_K_M", sizeGB: 5.0, minVramGB: 7, vision: true, description: "Vision-capable — can read and describe images." },
  { tag: "llama3.2-vision:11b", label: "Llama 3.2 Vision 11B", family: "Llama", paramsB: 11, quant: "Q4_K_M", sizeGB: 7.8, minVramGB: 10, vision: true, description: "Vision-capable Llama for image understanding." },
  { tag: "granite4.1:8b", label: "Granite 4.1 8B", family: "Granite", paramsB: 8, quant: "Q4_K_M", sizeGB: 4.9, minVramGB: 6, hfRepo: "ibm-granite/granite-3.1-8b-instruct", description: "IBM's enterprise-oriented instruction model." },
  { tag: "glm4:9b", label: "GLM-4 9B", family: "GLM", paramsB: 9, quant: "Q4_K_M", sizeGB: 5.5, minVramGB: 7, hfRepo: "THUDM/glm-4-9b-chat", description: "Strong bilingual (EN/ZH) chat model." },
  { tag: "deepseek-r1:8b", label: "DeepSeek-R1 8B", family: "DeepSeek", paramsB: 8, quant: "Q4_K_M", sizeGB: 4.9, minVramGB: 6, hfRepo: "deepseek-ai/DeepSeek-R1-Distill-Llama-8B", description: "Reasoning model — shows its chain-of-thought separately." },
  { tag: "deepseek-r1:14b", label: "DeepSeek-R1 14B", family: "DeepSeek", paramsB: 14, quant: "Q4_K_M", sizeGB: 9.0, minVramGB: 11, hfRepo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B", description: "Larger reasoning model, noticeably stronger than the 8B." },
  { tag: "phi4:14b", label: "Phi-4 14B", family: "Phi", paramsB: 14, quant: "Q4_K_M", sizeGB: 9.1, minVramGB: 11, hfRepo: "microsoft/phi-4", description: "Microsoft's 14B reasoning-focused model." },
  { tag: "gemma2:27b", label: "Gemma 2 27B", family: "Gemma", paramsB: 27, quant: "Q4_K_M", sizeGB: 16.0, minVramGB: 19, hfRepo: "google/gemma-2-27b-it", description: "Large Gemma variant, needs a bigger card." },
  { tag: "qwen2.5:32b", label: "Qwen 2.5 32B", family: "Qwen", paramsB: 32, quant: "Q4_K_M", sizeGB: 19.0, minVramGB: 22, hfRepo: "Qwen/Qwen2.5-32B-Instruct", description: "High-end Qwen — strong coding and reasoning." },
  { tag: "llama3.1:70b", label: "Llama 3.1 70B", family: "Llama", paramsB: 70, quant: "Q4_K_M", sizeGB: 40.0, minVramGB: 45, hfRepo: "meta-llama/Llama-3.1-70B-Instruct", description: "Flagship-class model — needs a high-VRAM card or multiple GPUs." },
  { tag: "mixtral:8x7b", label: "Mixtral 8x7B", family: "Mixtral", paramsB: 47, quant: "Q4_K_M", sizeGB: 26.0, minVramGB: 29, description: "Mixture-of-experts model, strong quality-to-active-compute ratio." },
  { tag: "nomic-embed-text", label: "Nomic Embed Text", family: "Embedding", paramsB: 0.137, quant: "F16", sizeGB: 0.27, minVramGB: 1, description: "Embedding model for document/RAG search — not a chat model." },
];
