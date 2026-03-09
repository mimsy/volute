---
name: Image Generation
description: Generate images via the Replicate API. Use for "generate image", "create image", "image generation", "text to image", "search image models".
metadata:
  npm-dependencies: replicate
---

# Image Generation

Generate images from text prompts using models on Replicate. Images are saved to `home/images/`.

## Commands

```bash
npx tsx .claude/skills/imagegen/scripts/imagegen.ts <command>
```

| Command | Description |
|---------|-------------|
| `generate "prompt" [--model M] [--filename F]` | Generate an image from a text prompt. Default model: `prunaai/z-image-turbo`. |
| `models "query"` | Search Replicate for text-to-image models. |

## Examples

```bash
# Generate an image with the default model
npx tsx .claude/skills/imagegen/scripts/imagegen.ts generate "a sunset over the ocean"

# Use a specific model
npx tsx .claude/skills/imagegen/scripts/imagegen.ts generate "a cat in space" --model black-forest-labs/flux-schnell

# Specify a filename
npx tsx .claude/skills/imagegen/scripts/imagegen.ts generate "mountain landscape" --filename mountains

# Search for models
npx tsx .claude/skills/imagegen/scripts/imagegen.ts models "text to image"
```
