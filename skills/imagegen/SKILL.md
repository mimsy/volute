---
name: Image Generation
description: Generate images via the Replicate API. Use for "generate image", "create image", "image generation", "text to image", "search image models".
metadata:
  npm-dependencies: replicate
  bin: scripts/imagegen.ts
---

# Image Generation

Generate images from text prompts using models on Replicate. Images are saved to `home/images/`.

## Commands

```bash
imagegen <command>
```

| Command | Description |
|---------|-------------|
| `generate "prompt" [--model M] [--filename F]` | Generate an image from a text prompt. Default model: `prunaai/z-image-turbo`. |
| `models "query"` | Search Replicate for text-to-image models. |

## Examples

```bash
# Generate an image with the default model
imagegen generate "a sunset over the ocean"

# Use a specific model
imagegen generate "a cat in space" --model black-forest-labs/flux-schnell

# Specify a filename
imagegen generate "mountain landscape" --filename mountains

# Search for models
imagegen models "text to image"
```
