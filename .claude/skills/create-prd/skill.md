---
name: create-prd
description: Based on the business context provided by the user, generate a structured B-end (B2B) PRD document (with initial content). Automatically triggers when the user asks to create, write, or generate a PRD, requirements document, or product plan, even if the user only says "help me write a PRD / plan / requirements doc."
---
 
# create-prd
 
Based on the business context and requirement background provided by the user, generate a structured B-end (B2B) PRD document with initial content.
 
Supports explicit invocation (e.g. `/create-prd`) and automatic triggering (when the user clearly asks to create or write a PRD, requirements document, product plan, or enterprise system design).
 
## Input
 
* Business context and requirement background provided by the user (free text, meeting notes, a brief description, etc. are all acceptable)
* Or a file path passed in via `$ARGUMENTS`
If an argument is passed in, prioritize it as the input source:
 
$ARGUMENTS
 
## Generation Flow
 
Execute strictly in the following order. Do not skip or reorder steps.
 
### Phase 0: Understand the context and determine the product type
 
1. Read and fully understand all business context the user has provided.
2. Infer from the user's description:
   * **Commercial attribute**: commercial product or in-house enterprise system
   * **Functional type**: business-management software / tool-type software / transaction platform / infrastructure-service type
3. Present the inferred result to the user in one sentence and request confirmation:
> Based on your description, this is a 【{commercial attribute} × {functional type}】 product{, brief rationale}. I will adjust the emphasis of each PRD chapter accordingly. Please correct me if anything is wrong.
 
4. Wait for the user's confirmation before continuing.
5. After confirmation, load the product-typing reference file to determine the adaptation rules for each chapter:
[Product Typing and Chapter Adaptation](references/appendices/create-prd-appendix-typing.md)
 
### Phase 1: Front chapters (Chapters 1-9)
 
Generate Chapters 1 through 9 in order. After completing each chapter, **output it immediately**; do not wait until all chapters are finished to output them together.
 
For each chapter, load the corresponding generation guide:
 
1. [Chapter 1 Project Background](references/chapters/create-prd-ch01-background.md)
2. [Chapter 2 Basic Requirement Overview](references/chapters/create-prd-ch02-basic.md)
3. [Chapter 3 Commercial Analysis](references/chapters/create-prd-ch03-commercial.md)
4. [Chapter 4 Project Benefit Goals](references/chapters/create-prd-ch04-goals.md)
5. [Chapter 5 Project Solution Overview](references/chapters/create-prd-ch05-overview.md)
6. [Chapter 6 Project Scope](references/chapters/create-prd-ch06-scope.md)
7. [Chapter 7 Project Risks](references/chapters/create-prd-ch07-risks.md)
8. [Chapters 8-9 Terminology and References](references/chapters/create-prd-ch08-09-terms.md)
### Phase 2: Core functional requirements (Chapter 10)
 
This is the largest and most core chapter of the PRD. Load the generation guide:
 
9. [Chapter 10 Functional Requirements](references/chapters/create-prd-ch10-functions.md)
Generate section by section:
 
* 10.1 Product Framework Overview (system framework diagram, data model diagram, business process diagram, state machine diagram, feature list)
* 10.2 Product Requirement Details (module by module: process diagram → page interaction → business rules)
* 10.3 Exception Handling Solutions
### Phase 3: Back chapters (Chapters 11-14)
 
10. [Chapter 11 Data Tracking (Analytics Events)](references/chapters/create-prd-ch11-tracking.md)
11. [Chapter 12 Roles and Permissions](references/chapters/create-prd-ch12-permissions.md)
12. [Chapter 13 Operations Plan](references/chapters/create-prd-ch13-operations.md)
13. [Chapter 14 Open Items](references/chapters/create-prd-ch14-tbd.md)
### Phase 4: Self-check and gap analysis
 
After all chapters are generated, perform a lightweight self-check:
 
14. [Self-Check and To-Be-Completed List](references/appendices/create-prd-appendix-selfcheck.md)
## Output Specification
 
### Document format
 
Output the PRD as a single Markdown document, structured as follows:
 
```
# {Product/Project Name} PRD
 
| PRD Reviewer | {to be filled in} |
| --- | --- |
| Importance | {high/medium/low} |
| Urgency | {high/medium/low} |
| Requester | {inferred from context or marked to be filled in} |
| PRD Author | {user's name or to be filled in} |
| PRD Submission Date | {current date} |
 
## PRD Revision Log
 
| Change Time | Change Content | Requesting Department & Reason | Modified By | Reviewed By | Version |
| --- | --- | --- | --- | --- | --- |
| {current date} | Initial version | — | {author} | {to be filled in} | v1.0 |
 
---
 
## 1. Project Background
...(content of each chapter)
 
## 14. Open Items
...
 
---
 
## Appendix: To-Be-Completed List
...
```
 
### Content generation rules
 
1. **Generate substantive content when information exists**: Based on the context the user provides, generate a concrete, substantive draft as much as possible.
2. **Mark `[TODO]` when information is insufficient**: For parts where the user has not provided enough information, mark with `[TODO: what specifically needs to be added]` rather than fabricating content.
3. **Distinguish product types**: Commercial products and in-house enterprise systems emphasize different content; adjust strictly according to the product-typing result.
4. **Make the theoretical framework explicit**: In key chapters, use a brief note to explain the methodology framework being applied, helping the user understand the design rationale.
5. **Structure first**: Prefer tables, lists, and Mermaid diagrams over long narrative passages.
6. **Use Mermaid for diagrams**: Architecture diagrams, process diagrams, state machines, ER models, etc. are all generated using Mermaid code blocks; do not use ASCII pseudo-diagrams.
### Diagram generation rules
 
In the Chapter 10 Product Framework Overview, the following diagrams **must use Mermaid syntax**:
 
| Diagram Type | Mermaid Syntax | Must Include |
| --- | --- | --- |
| Application architecture diagram | `graph TB` + `subgraph` layering | User layer, access layer, business service layer, data layer, external systems |
| ER data model | `erDiagram` | All core entities + relationships + key attributes (PK/FK/status) |
| Business process diagram | `flowchart TD` | Main flow + key branches + exception paths, with key nodes colored |
| State machine diagram | `stateDiagram-v2` | Normal + exception paths, with notes explaining constraints |
 
**Notes:**
 
* After a Mermaid diagram, attach a corresponding detail table as supplementary explanation (e.g. a state machine diagram + a state transition table)
* Use `<br/>` for line breaks in node text within diagrams, keeping them concise
* See the Chapter 10 generation guide file for specific templates and examples
### Chapter-by-chapter output rules
 
* Output each chapter immediately upon completion; do not wait until all chapters are finished to output them together.
* Each chapter must have a clear chapter heading, consistent with the PRD template structure.
* Prefer tables for structured data (fields, permissions, rules, etc.).
* Use a `> 💡 Methodology note:` blockquote to present the theoretical framework being applied.
* Mark uncertain content with `[TODO]` and explain what information needs to be added.
## Working Style
 
* The goal is to generate a usable PRD scaffold that accelerates the product manager's work, not to replace their judgment.
* When the user's context is sufficient, be as concrete and substantive as possible; when information is insufficient, honestly mark the gaps.
* Maintain a professional PRD writing style: precise, structured, and unambiguous.
* Adjust depth according to the richness of the context the user provides — a one-paragraph context generates a lightweight PRD, a detailed context generates a rich PRD.
* If the context provided by the user is very limited, generate a structural framework with guidance notes, and proactively ask which additional information would help flesh out the key chapters.