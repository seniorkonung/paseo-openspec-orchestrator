### TypeScript MCP

When TypeScript MCP is available, use it for semantic TypeScript investigation
before relying on text search:

- use `workspace_symbol_search` and `get_document_symbols` to locate symbols;
- use `get_hover` and `get_signature_help` for type and API information;
- use `get_definition`, `go_to_type_definition`, and `go_to_implementation`
  for semantic navigation;
- use `get_references`, `prepare_call_hierarchy`, `get_incoming_calls`, and
  `get_outgoing_calls` to trace usage and call relationships;
- use `get_diagnostics` to analyze affected files and `get_code_actions` to
  inspect language-server fixes and refactorings.

`format_document`, `rename_symbol`, and code actions return proposed edits; they
do not modify files. Review their results and apply the edits with the normal
editing tools.

Use repository search and the package manager's CLI for package metadata,
dependency source, generated files, or other questions the language server
cannot answer. If the TypeScript server behaves unexpectedly, inspect
`get_server_logs` before falling back to CLI-only investigation.

After changing TypeScript code, run `get_diagnostics` for the affected files.
Also run the repository's normal type-check, lint, test, build, and generation
commands as applicable; MCP diagnostics do not replace project-level
verification.
