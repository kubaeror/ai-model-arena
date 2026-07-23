# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# Workflow
- When executing a multi-phase implementation plan, automatically continue to the next phase after completing the current one. Confidence: 0.80
- Save flagged issues (bugs found but not fixed, pre-existing warnings, items for later phases) to docs/superpowers/flagged-issues.md. Confidence: 0.85
- When investigating CI failures or GitHub-related issues, use the `gh` CLI instead of file exploration tools. Confidence: 0.65

# Git
- Use conventional commit format with `feat:` prefix, a descriptive summary line, and a bulleted summary of changes in the body. Include `Co-authored-by: CommandCodeBot <noreply@commandcode.ai>` trailer. Confidence: 0.70

# Verification
- Before committing, run `npx tsc --noEmit` for typecheck and `kubectl kustomize` for manifest validation as final verification steps. Confidence: 0.65

# Project Structure
- Store implementation plan documents in `docs/plans/{feature-name}.md`. Confidence: 0.60

