---
name: llm-council
description: Route a decision through the independent Decagram Council workflow.
---

# LLM Council router

Do not roleplay several advisors in one context.

The council must run through the `council-lead` main-session agent, which
creates five independent advisor contexts and a separate chairman context.

If the current session is not `council-lead`, tell the caller to use the
Decagram Council app's Council Review action or launch:

`claude --agent council-lead`

Then pass the exact question and named evidence files unchanged. Do not produce
an abbreviated council answer in this skill's context.
