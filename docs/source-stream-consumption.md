# Source media consumption

The podcast and video adapters accept an optional internal `consume(media)` callback.
The callback is awaited while network/file resources remain owned by the adapter.
`media.body` is an async-readable stream in production; older injected adapters may
still supply a Buffer. The callback must fully consume it or reject. Its return
value is not media data. On success the adapter returns its ordinary metadata with
no `body`. Without `consume`, the existing HTTP response API retains its Buffer
contract.

- Podcast response bytes flow through a bounded reader. Nonempty-body,
  Content-Length, transfer completion and size-limit checks happen before readable
  EOF, so a storage consumer cannot commit after an invalid transfer. The existing
  total/idle deadlines, redirect policy and DNS/IP validation remain in effect.
  `size` is available only when the server declared Content-Length; source SHA256
  is not known in advance and the storage writer calculates it incrementally.
- Video helpers already download into an isolated file. The adapter verifies that
  opened file's size, signature and SHA256 in bounded chunks, then lends a stream
  from the same descriptor. `size` and `sha256` are supplied to the consumer. The
  storage writer must check these expectations before committing, including if the
  file changes during consumption. The private helper directory is removed only
  after consumption completes, rejects or is cancelled.
- This removes whole-file Buffer allocations from background acquisition, not the
  video's complete-download barrier. It does not yet overlap network decoding or
  ASR. Older HTTP download routes remain buffered until migrated by their callers.

Tests use authored bytes, not actual platform media or model inference. They cover
EOF rejection, limits, consumer failure, abort cleanup and helper file lifetime.
