# cloudcode-link-core

Headless core library for Google Cloud Code / Antigravity multi-account pool, OAuth PKCE lifecycle, model catalog, and Gemini / Claude / GPT-OSS protocol converters.

## Features

- **Headless & Zero Host Dependencies**: Pure TypeScript & Node.js library. No coupling to any editor or host application framework.
- **Path Externalization**: Complete support for external directory injection (`poolDir`, `storageDir`, `stagingDir`). Zero hardcoded paths.
- **Multi-Account Pool Management**: Sticky Sequential Drain scheduling, user pin lock, automatic cooldown recovery, and strict POSIX permissions (`0o700` directories, `0o600` credential files).
- **Session Affinity**: Deterministic FNV-1a 64-bit signed `wireSessionId`, constant `trajectoryId`, and monotonic `last_step_index` counter.
- **Protocol Sanitation**: Rigorous Gemini thought signature validation (`validateThoughtSignature`), unpaired `functionResponse` safe degradation, and turn ordering enforcement.
- **SSE Stream Assembly**: Robust Server-Sent Events mapper with incremental tool calling slices stitched via `BlockAssembler`.

## License

MIT © [WinterSold1er](https://github.com/WinterSold1er)
