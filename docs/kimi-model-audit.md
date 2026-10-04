# Kimi integration audit

Reviewed on October 3, 2026. The configured API key successfully authenticated
against the model-list endpoint, which returned `kimi-k2.6`, `kimi-k3`,
`kimi-k2.7-code`, and `kimi-k2.7-code-highspeed`.

| App role           | Default     | Request configuration             |
| ------------------ | ----------- | --------------------------------- |
| CPU default / fast | `kimi-k2.6` | Thinking disabled                 |
| CPU reasoning      | `kimi-k3`   | High reasoning effort             |
| Coach              | `kimi-k2.6` | Thinking disabled                 |
| Deep coach         | `kimi-k3`   | High reasoning effort             |
| JSON extractor     | `kimi-k2.6` | Thinking disabled                 |
| Teambuilder        | `kimi-k2.6` | Thinking disabled; function tools |

This selection is an inference from the documented capabilities, not a
Pokemon-specific quality benchmark. K2.6 supports general tasks and an instant
mode suited to interactive turns. K3 supplies stronger reasoning for explicitly
selected reasoning/deep modes. The K2.7 Code series targets coding and cannot
disable thinking. The model catalog marks K2.5 and earlier K2 preview models as
discontinued, so they are not used.

## Compatibility changes

- Keep the existing OpenAI Node SDK, but configure the Kimi credential and
  `https://api.moonshot.ai/v1` base URL for both CPU and teambuilder calls.
- Use the AI SDK's explicit Chat Completions adapter for coaching and extraction.
  The installed OpenAI adapter does not forward a `thinking` provider option;
  inject that field through its custom fetch transport.
- K2.6 accepts `thinking.type` enabled/disabled but rejects `reasoning_effort`.
  K3 always reasons, accepts low/high/max effort, and does not accept K2's
  `thinking` configuration. Avoid specifying temperature/top-p: these models
  fix those parameters.
- Keep the supported `max_completion_tokens` on native calls. The installed AI
  SDK emits the older, still accepted `max_tokens` field. Budget 16,384 tokens
  for thinking, 512 for instant CPU decisions, and 2,048 for coaching/extraction.
- Streaming decisions consume final `content`, not private `reasoning_content`.
  Preserve complete assistant messages during the teambuilder's tool loop.
- Kimi supports `json_schema` and JSON mode. Continue validating extracted
  guidance with Zod. K2.6 works best with simple schemas; complex `$ref`/`oneOf`
  schemas may behave less consistently. No forced `tool_choice: required` is
  sent because K2.6 does not support it.
- Provider selection is shared by all AI paths. Setting `AI_PROVIDER=kimi`
  requires the Kimi key and prevents silently using an exhausted OpenAI account.
  Existing OpenAI model settings do not leak into Kimi requests.

## Official sources

- [Model catalog](https://platform.kimi.ai/docs/models)
- [Model parameter reference](https://platform.kimi.ai/docs/api/models-overview)
- [K2.6 quickstart](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart)
- [Chat Completions API](https://platform.kimi.ai/docs/api/chat)
- [Structured output](https://platform.kimi.ai/docs/guide/response_format)
- [Thinking and tool loops](https://platform.kimi.ai/docs/guide/use-thinking-models)

## Verification

- Nx API tests: 45 passed across 12 suites. Typecheck, lint, and build passed;
  lint reports five existing warnings.
- Live CPU streaming succeeded for K2.6 fast and K3 reasoning, selecting a legal
  move without truncation. AI SDK text generation and schema extraction passed.
- Live teambuilder chat successfully looked up Pikachu and consumed its verified
  Electric type in a two-round tool conversation.
- The account reports a limit of three requests per minute. Live checks needed
  pacing to avoid HTTP 429 responses. CPU plus coaching and multi-step team
  building can exceed that quota during normal use; higher account limits would
  improve interactive play.
