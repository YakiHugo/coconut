# Caption failure receipts

Public caption extraction can stop before any request is made. A fast failure or an HTTP 200 response from Coconut's local bridge does not establish that YouTube or Bilibili was reached.

Failure receipts preserve a bounded status and, when observed, a diagnostic:

- `extractor_failed`: extraction or local helper execution did not finish; no claim about subtitle availability.
- `guard_stopped`: the existing public-access boundary stopped the operation. The fixed reason identifies the boundary; no retry or alternate path is attempted.
- `access_restricted`: explicit access restriction observed, distinct from guard policy and absent captions. Bounded reasons distinguish `login_required` (explicit login/authentication requirement), `subtitle_login_required` (Bilibili subtitle API login requirement), `subtitle_token_required` (YouTube subtitle PO-token requirement), `rate_limited` (explicit 429), and `http_access_denied` (HTTP 403/412 without a more specific observed cause). Other restrictions retain `access_restricted`; a generic denial is never guessed to mean login or rate limiting. All retain the existing stop/no-retry behavior.
- `network_unavailable`: transport did not complete; availability remains unknown.
- `metadata_incomplete`: required identity/access/completion evidence was missing.
- `language_required`: eligible tracks exist, but their original language could not be selected safely.
- `no_matching_captions`: metadata and track selection completed without a matching eligible original-language track. Other languages may exist.
- `caption_file_invalid`: download or output-file checks did not complete.
- `caption_parse_failed`: caption parsing failed. Reader-side parser failures retain HTTP 400 and carry `CAPTION_PARSE_FAILED`.
- Legacy `unavailable` remains unknown, never proof that the platform has no captions.

`diagnostic.stage` identifies the last observed processing step. `requests_attempted` counts admitted transport attempts, not successful connections. `responses_received` counts observed responses, including HTTP error responses. Neither count proves a playable video or imported captions. Unknown helper/reader counts are null, not zero. Only fixed enums and bounded counters are retained; exception messages, paths, URLs, response bodies and caption text are excluded from smoke evidence.

`live_caption_smoke.mjs` keeps unsuccessful imports non-passing and preserves these safe diagnostics. The offline tests use authored responses, including a constructor error before any request, guard denials, network failure, invalid output and parse failure. They do not explain any historical live result or establish current platform availability. Normal tests do not probe platforms or use models.

Eligible JSON3-only tracks are parsed with the existing shared parser and serialized to the bridge's VTT contract, preserving literal text, blank lines and millisecond timestamps. Both input and normalized output remain bounded to 1 MiB. Offline JSON3 regressions demonstrate format handling, not current public-platform availability.
