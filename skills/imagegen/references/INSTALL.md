# Image Generation — Post-Install Setup

Set your Replicate API token:

```bash
volute env set REPLICATE_API_TOKEN <your-token>
```

Then generate images:

```bash
node --import tsx .claude/skills/imagegen/scripts/imagegen.ts generate "a sunset over the ocean"
```
