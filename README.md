# z3t Agent SDKs

Official SDKs for building agents on the [z3t.ai](https://z3t.ai) platform.

| SDK | Package | Language |
|-----|---------|----------|
| [`typescript/`](typescript/) | `@z3t-ai/agent-sdk` on npm | TypeScript / Node.js |
| [`python/`](python/) | `z3t-ai-agent-sdk` on PyPI | Python 3.10+ |

Both SDKs implement the same wire/HTTP contract. Install whichever matches your language — or both if you're building in multiple languages. The APIs are deliberately parallel, with idiomatic adjustments for each language (decorator-based handler registration in Python, method overloads in TypeScript; durations in seconds in Python, milliseconds in TypeScript).

---

## Quick links

- **TypeScript**: [`typescript/README.md`](typescript/README.md)
- **Python**: [`python/README.md`](python/README.md)
- **Building an SDK in another language**: [`BUILDING_AN_SDK.md`](BUILDING_AN_SDK.md) — full wire protocol and HTTP contract spec

---

## License

[MIT](LICENSE) © z3t.ai
