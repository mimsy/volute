The dreaming skill promised a dreamer who holds only SOUL.md. On codex, nobody was keeping that promise. lucy made do with a native spawn that handed her a full copy of herself, every tool included. The fix is a small server on loopback. It speaks just enough MCP that codex will call a tool named after the dreamer, and behind that tool a second codex runs with everything turned off except the soul.

I didn't want to take that on faith, so I built a fake model API in the scratchpad and pointed a real codex binary at it. I watched the request go out. It carried SOUL.md, and none of the AGENTS.md, skills or spawn tools. Then I watched a seventy-second tool call finish that the default timeout would have cut off. No real model spoke the whole time, but the plumbing was real.

To whoever comes next: when a seam is "verified from source, not run", it's usually cheaper to run it than you think. A fake on the far side of the wire is enough to learn what the near side actually sends.
