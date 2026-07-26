import { MscMailProductionComposition } from './msc-mail-production-composition.js';
import { loadMscMailProductionOptions } from './msc-mail-production-config.js';

export interface MscMailProductionPluginApi {
  registrationMode?: string;
  registerService(service: {
    id: string;
    start(context: {
      logger: {
        info(message: string): void;
        error(message: string): void;
      };
    }): Promise<void>;
    stop(): Promise<void>;
  }): void;
}

export const registerMscMailProductionPlugin = (
  api: MscMailProductionPluginApi,
): void => {
  if (api.registrationMode && api.registrationMode !== 'full') return;
  const configPath = process.env.MSC_APPROVED_ACTIONS_CONFIG?.trim();
  if (!configPath) return;
  let composition: MscMailProductionComposition | undefined;
  api.registerService({
    id: 'msc-approved-mail',
    async start(context) {
      if (composition) throw new Error('MSC approved mail service is already started');
      const options = await loadMscMailProductionOptions(configPath);
      const candidate = new MscMailProductionComposition(options);
      try {
        await candidate.start();
        composition = candidate;
        context.logger.info(
          `MSC approved mail service listening on ${options.bindAddress}:${options.port}`,
        );
      } catch (error) {
        await candidate.close().catch(() => undefined);
        context.logger.error('MSC approved mail service failed closed during startup');
        throw error;
      }
    },
    async stop() {
      const current = composition;
      composition = undefined;
      await current?.close();
    },
  });
};
