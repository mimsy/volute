#!/bin/bash
# With memory.recall "off", stop here, before paying for a tsx start every turn.
if node -e 'try{const c=require(process.env.VOLUTE_MIND_DIR+"/home/.config/config.json");process.exit(c&&c.memory&&c.memory.recall==="off"?0:1)}catch{process.exit(1)}' 2>/dev/null; then
  echo '{}'
  exit 0
fi
# Resolve the script next to this one, so the hook works wherever the template keeps
# its skills (.claude/skills, .agents/skills, .pi/skills).
exec node --import tsx "$(dirname "$0")/resonance.ts" search-hook
