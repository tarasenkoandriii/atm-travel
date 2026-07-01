// DI token collecting all eSIM provider implementations (multi-provider).
// Adding a second provider (e.g. Ubigi) means registering it under this token in EsimModule —
// the domain service is not touched.
export const ESIM_PROVIDERS = Symbol('ESIM_PROVIDERS');
