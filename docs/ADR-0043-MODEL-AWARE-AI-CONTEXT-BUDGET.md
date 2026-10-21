# ADR-0043: AI evidence budgets derive from the selected model connection

## Context

AI context preparation previously used one fixed ceiling of 12,000 characters and 6,000 estimated tokens. That is conservative but wastes capable model windows and can still be too large for a smaller or local endpoint once system instructions and answer tokens are included.

Inferring context limits from model-name strings is brittle: providers can add aliases, revise offerings or accept arbitrary deployment IDs. Echo-8 must not silently depend on a permanently incomplete model table.

## Decision

Every chat connection may store a user/provider-declared total context-window size. The advanced connection form defaults to 16,000 tokens and accepts 4,000 through 10,000,000. This is connection metadata only; it contains no secret and follows the existing personal connection backup flow.

The assistant resolves the exact profile selected by its window before context preparation. Evidence receives 37.5% of the declared window, bounded between 1,500 and 36,000 estimated tokens. The corresponding character ceiling remains conservative at two UTF-16 characters per evidence token. Transcript and minimum-memory windows scale inside their own caps. The rest of the model window remains available for product instructions, prompt templates, the user request, provider tokenization differences and the answer.

If the provider capability is absent, the profile has no usable declaration, or a test supplies an explicit budget, the established 12,000-character/6,000-token budget remains unchanged. The review details show both the evidence budget and declared model window.

## Consequences

- Different assistant windows can use different evidence budgets without mutating global state.
- Arbitrary model IDs remain supported; the user controls the authoritative limit.
- A wrong declaration can still cause a provider rejection, so the UI describes it as the platform-published limit rather than a guarantee.
- Public generation and retrieval capabilities remain version-compatible; the prepared-context diagnostic gains optional budget metadata.
