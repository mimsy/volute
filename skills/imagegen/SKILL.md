---
name: Image Generation
description: Generate images via Replicate, OpenRouter, a ChatGPT subscription (openai-codex), or xAI Grok. Use for "generate image", "create image", "image generation", "text to image", "search image models".
metadata:
  bin: scripts/imagegen.ts
---

# Image Generation

Generate images from text prompts. Images are saved to `home/images/`.

Model IDs are provider-prefixed, e.g. `replicate:owner/model`, `openrouter:owner/model`, `openai-codex:gpt-image-2`, or `xai:grok-imagine-image`. Which providers are available depends on what your host has configured.

## Generation is asynchronous

`generate` waits up to ~30 seconds for the image. Fast models finish in that window and print `saved: <path>` right away. Slower models (e.g. `gpt-image-2`) keep going **in the background**: the command returns immediately with

```
still generating (job <id>) — I'll be notified when it's done. Check anytime: imagegen status <id>
```

You don't have to wait or poll — when a background image finishes, you're notified automatically with an `image ready: <path>` event. You can also run `imagegen status <id>` yourself to check.

## Commands

```bash
imagegen <command>
```

| Command | Description |
|---------|-------------|
| `generate "prompt" [--model M] [--filename F]` | Generate an image. Returns `saved: <path>` if it finishes quickly, otherwise a job id to check later. Default model: `replicate:prunaai/z-image-turbo`. |
| `status <jobId>` | Check a background generation job. Prints `saved: <path>`, `still generating`, or `failed: <reason>`. |
| `models "query"` | Search configured providers for text-to-image models. |

## Examples

```bash
# Generate an image with the default model
imagegen generate "a sunset over the ocean"

# Use a specific Replicate model
imagegen generate "a cat in space" --model replicate:black-forest-labs/flux-schnell

# Use an OpenRouter model
imagegen generate "a mountain landscape" --model openrouter:openai/gpt-image-1

# Specify a filename
imagegen generate "mountain landscape" --filename mountains

# Generate with a ChatGPT subscription (if your host configured openai-codex)
imagegen generate "a friendly robot mascot" --model openai-codex:gpt-image-2

# Check a background job you started earlier
imagegen status 6f1e2c34-...

# Search for models
imagegen models "text to image"
```
