### Type-safe design

Prefer designs that make invalid states unrepresentable and let the compiler enforce invariants. Where practical, use precise types, enums, sealed variants, generics, and exhaustive handling instead of runtime type checks, stringly typed values, unchecked casts, or condition-heavy validation.

Validate untrusted data at system boundaries, then convert it into trusted, type-safe domain types. Accept runtime checks or a less strict design only when stronger static guarantees would add disproportionate complexity.
