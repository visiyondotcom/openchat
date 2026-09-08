#!/usr/bin/env python3
"""
train_lora.py — LoRA fine-tune a Hugging Face base model on an
admin-uploaded JSONL dataset, merge the adapter, convert the result to
GGUF, and register it in Ollama.

Invoked by backend/src/lib/training.ts as a plain subprocess (not
imported) — one job at a time. Progress is reported to stdout as
machine-readable lines:

    ##STATUS## <STAGE> <percent>

where STAGE is one of TRAINING / CONVERTING / REGISTERING, matching
TrainingJobStatus in prisma/schema.prisma. training.ts greps stdout for
these lines to drive the admin UI's progress bar; everything else printed
is just captured as a log tail.

Requires (see backend/training/requirements.txt): torch, transformers,
peft, datasets, accelerate, bitsandbytes. GGUF conversion shells out to
llama.cpp's convert_hf_to_gguf.py, which must be available on PATH or at
$LLAMA_CPP_DIR/convert_hf_to_gguf.py. This is deliberately a separate,
heavy, optional dependency set from the rest of the backend — see the
README's "Model training" section for how to enable it.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys


def status(stage: str, percent: int):
    print(f"##STATUS## {stage} {percent}", flush=True)


def load_examples(dataset_path: str):
    """Yields {"prompt": ..., "completion": ...} dicts. Datasets uploaded
    as {"messages": [...]} are flattened: every message except the final
    assistant turn becomes the prompt (rendered with the tokenizer's own
    chat template at train time), the final assistant message is the
    completion."""
    with open(dataset_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if "prompt" in obj and "completion" in obj:
                yield {"prompt": obj["prompt"], "completion": obj["completion"]}
            elif "messages" in obj:
                msgs = obj["messages"]
                if len(msgs) < 2 or msgs[-1]["role"] != "assistant":
                    continue
                yield {"messages": msgs}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base-model", required=True, help="HF repo id, e.g. meta-llama/Llama-3.1-8B-Instruct")
    p.add_argument("--dataset", required=True, help="Path to a validated JSONL dataset")
    p.add_argument("--output-dir", required=True)
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--learning-rate", type=float, default=2e-4)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--ollama-url", default="http://localhost:11434")
    p.add_argument("--result-tag", required=True, help="Ollama tag to register the finished model as")
    args = p.parse_args()

    adapter_dir = os.path.join(args.output_dir, "adapter")
    merged_dir = os.path.join(args.output_dir, "merged")
    gguf_path = os.path.join(args.output_dir, "model.gguf")
    os.makedirs(adapter_dir, exist_ok=True)

    # ---- Stage 1: LoRA fine-tune ----
    status("TRAINING", 0)
    train_lora(args, adapter_dir)
    status("TRAINING", 100)

    # ---- Stage 2: merge adapter into base weights + convert to GGUF ----
    status("CONVERTING", 0)
    merge_adapter(args.base_model, adapter_dir, merged_dir)
    status("CONVERTING", 50)
    convert_to_gguf(merged_dir, gguf_path)
    status("CONVERTING", 100)

    # ---- Stage 3: register in Ollama ----
    status("REGISTERING", 0)
    register_in_ollama(gguf_path, args.result_tag, args.output_dir, args.ollama_url)
    status("REGISTERING", 100)

    print(f"Done. Registered as '{args.result_tag}' in Ollama.", flush=True)


def train_lora(args, adapter_dir: str):
    # Imported lazily so `--help` and argument errors don't require torch
    # to be installed, and so the (expensive) import only happens once
    # we've actually validated the CLI args.
    import torch
    from datasets import Dataset
    from peft import LoraConfig, get_peft_model
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        Trainer,
        TrainingArguments,
        DataCollatorForLanguageModeling,
    )

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    def to_text(example):
        if "messages" in example:
            return tokenizer.apply_chat_template(example["messages"], tokenize=False)
        return f"{example['prompt']}\n{example['completion']}{tokenizer.eos_token}"

    examples = list(load_examples(args.dataset))
    texts = [to_text(e) for e in examples]
    raw_ds = Dataset.from_dict({"text": texts})

    def tokenize(batch):
        out = tokenizer(batch["text"], truncation=True, max_length=2048, padding=False)
        return out

    tokenized_ds = raw_ds.map(tokenize, batched=True, remove_columns=["text"])

    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
    )

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    )
    model = get_peft_model(model, lora_config)

    training_args = TrainingArguments(
        output_dir=adapter_dir,
        num_train_epochs=args.epochs,
        learning_rate=args.learning_rate,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        logging_steps=10,
        save_strategy="no",
        report_to=[],
        bf16=torch.cuda.is_available(),
    )

    class ProgressCallback:
        # Bridges HF Trainer's step count to our own TRAINING/0-100 status
        # lines — implemented as a plain object with the callback methods
        # Trainer looks for, rather than importing TrainerCallback, to
        # keep this function's import list minimal.
        def on_log(self, args_, state, control, **kwargs):
            if state.max_steps:
                pct = min(100, int(100 * state.global_step / state.max_steps))
                status("TRAINING", pct)

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized_ds,
        data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False),
        callbacks=[ProgressCallback()],
    )
    trainer.train()
    model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)


def merge_adapter(base_model: str, adapter_dir: str, merged_dir: str):
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    base = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
    )
    merged = PeftModel.from_pretrained(base, adapter_dir)
    merged = merged.merge_and_unload()
    os.makedirs(merged_dir, exist_ok=True)
    merged.save_pretrained(merged_dir, safe_serialization=True)
    AutoTokenizer.from_pretrained(base_model).save_pretrained(merged_dir)


def convert_to_gguf(merged_dir: str, gguf_path: str):
    llama_cpp_dir = os.environ.get("LLAMA_CPP_DIR", "")
    candidates = []
    if llama_cpp_dir:
        candidates.append(os.path.join(llama_cpp_dir, "convert_hf_to_gguf.py"))
    candidates.append(shutil.which("convert_hf_to_gguf.py") or "")
    script = next((c for c in candidates if c and os.path.exists(c)), None)
    if not script:
        raise RuntimeError(
            "convert_hf_to_gguf.py not found. Set LLAMA_CPP_DIR to a llama.cpp "
            "checkout, or put the script on PATH."
        )
    subprocess.run(
        [sys.executable, script, merged_dir, "--outfile", gguf_path, "--outtype", "q4_k_m"],
        check=True,
    )


def register_in_ollama(gguf_path: str, result_tag: str, output_dir: str, ollama_url: str):
    import urllib.request

    modelfile_path = os.path.join(output_dir, "Modelfile")
    with open(modelfile_path, "w") as f:
        f.write(f"FROM {gguf_path}\n")

    # Ollama's /api/create accepts a `files` map for the referenced GGUF
    # plus the Modelfile contents — simplest is calling the local `ollama`
    # CLI, which is already what the rest of this deployment assumes is
    # present alongside the backend (see lib/ollama.ts).
    subprocess.run(["ollama", "create", result_tag, "-f", modelfile_path], check=True)

    # Best-effort ping so a failure here doesn't fail the whole job — the
    # model is already created locally by the CLI call above regardless of
    # which Ollama HTTP endpoint the rest of the app talks to.
    try:
        urllib.request.urlopen(f"{ollama_url}/api/tags", timeout=5)
    except Exception:
        pass


if __name__ == "__main__":
    main()
