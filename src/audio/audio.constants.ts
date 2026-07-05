// DI token collecting all audio provider implementations (multi-provider).
// Adding a provider means registering it under this token in AudioModule — the domain service
// (AudioService) and every caller stay untouched.
export const AUDIO_PROVIDERS = Symbol('AUDIO_PROVIDERS');
