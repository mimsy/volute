---
name: Image Generation
description: Generate images via Replicate or OpenRouter. Use for "generate image", "create image", "image generation", "text to image", "search image models".
metadata:
  bin: scripts/imagegen.ts
---

# Image Generation

Generate images from text prompts using models on Replicate or OpenRouter. Images are saved to `home/images/`.

Model IDs are provider-prefixed: `replicate:owner/model` or `openrouter:owner/model`.

## Commands

```bash
imagegen <command>
```

| Command | Description |
|---------|-------------|
| `generate "prompt" [--model M] [--filename F]` | Generate an image from a text prompt. Default model: `replicate:prunaai/z-image-turbo`. |
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

# Search for models
imagegen models "text to image"
```
