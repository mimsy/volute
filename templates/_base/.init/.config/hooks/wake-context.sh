#!/bin/bash
# Wake context hook — generates context when waking from sleep.
# Input: JSON on stdin with { "sleepingSince": "ISO", "duration": "Xh Ym", "wakeTime": "ISO" }
# Output: Plain text included in the wake-up summary. Empty output = nothing added.
#
# Skills and extensions can append to this script to surface what happened during sleep.
# Example: check for new dream files, summarize overnight activity, etc.
