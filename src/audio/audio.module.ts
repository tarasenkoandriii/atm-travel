import { Module } from '@nestjs/common';
import { AUDIO_PROVIDERS } from './audio.constants';
import { AudioService } from './audio.service';
import { JamendoProvider } from './providers/jamendo.provider';
import { FreesoundProvider } from './providers/freesound.provider';
import { MubertProvider } from './providers/mubert.provider';

/**
 * Wires the audio-source abstraction into Nest. Concrete adapters are @Injectable and constructed
 * by the container (each reads its own keys from ConfigService); the factory collects them into the
 * AUDIO_PROVIDERS array — no manual registry.register() anywhere. Adding a provider = add its class
 * below and push it into the factory array; AudioService and callers stay untouched.
 */
@Module({
  providers: [
    JamendoProvider,
    FreesoundProvider,
    MubertProvider,
    {
      provide: AUDIO_PROVIDERS,
      useFactory: (jamendo: JamendoProvider, freesound: FreesoundProvider, mubert: MubertProvider) =>
        [jamendo, freesound, mubert],
      inject: [JamendoProvider, FreesoundProvider, MubertProvider],
    },
    AudioService,
  ],
  exports: [AudioService, AUDIO_PROVIDERS],
})
export class AudioModule {}
