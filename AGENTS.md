## Code intelligence routing

Use CodeGraph as the default tool for source-code implementation questions.

Use CodeGraph when the task involves:
- locating symbols or implementations;
- callers, callees, imports, inheritance, routes, or call flows;
- debugging;
- refactoring;
- estimating the blast radius of a code change;
- reading current source after recent edits.

Use Graphify when the task involves:
- architecture or subsystem discovery;
- community, centrality, or god-node analysis;
- relationships across code, documentation, ADRs, PDFs, schemas, images,
  or other non-code artifacts;
- architecture reports or graph visualization;
- long-term project knowledge exploration.

Do not call both tools for the same question by default.

Fallback rules:
1. Start with CodeGraph for code-centric tasks.
2. Start with Graphify for cross-document or architecture-centric tasks.
3. Call the second tool only when the first tool lacks the required source type
   or cannot establish the requested relationship.
4. After receiving current source from CodeGraph, do not repeat the same search
   with grep unless the result reports stale or missing data.
5. After code changes, prefer CodeGraph for current implementation details.
   Treat Graphify reports as architectural context unless its graph has been
   refreshed.
