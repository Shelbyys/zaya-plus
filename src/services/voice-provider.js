// ================================================================
// VOICE PROVIDER — Abstração para múltiplos provedores de voz
// Suporta: Twilio, Plivo, Telnyx, Vonage
// ================================================================
import { log } from '../logger.js';

export function getVoiceProvider() {
  const provider = (process.env.VOICE_PROVIDER || 'twilio').toLowerCase();
  return provider;
}

export function isVoiceEnabled() {
  const provider = getVoiceProvider();
  switch (provider) {
    case 'twilio':
      return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
    case 'plivo':
      return !!(process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN && process.env.PLIVO_PHONE_NUMBER);
    case 'telnyx':
      return !!(process.env.TELNYX_API_KEY && process.env.TELNYX_PHONE_NUMBER);
    case 'vonage':
      return !!(process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET && process.env.VONAGE_PHONE_NUMBER);
    default:
      return false;
  }
}

export async function makeCall(toNumber, message) {
  const provider = getVoiceProvider();
  log.ai.info({ provider, to: toNumber }, 'Iniciando ligação');

  switch (provider) {
    case 'twilio': {
      const mod = await import('./twilio.js');
      return mod.makeCall(toNumber, message);
    }
    case 'plivo': {
      const mod = await import('./plivo.js');
      return mod.makeCall(toNumber, message);
    }
    case 'telnyx': {
      const mod = await import('./telnyx.js');
      return mod.makeCall(toNumber, message);
    }
    case 'vonage': {
      const mod = await import('./vonage.js');
      return mod.makeCall(toNumber, message);
    }
    default:
      return { success: false, error: `Provedor de voz "${provider}" não suportado` };
  }
}

export async function makeSimpleCall(toNumber, message) {
  const provider = getVoiceProvider();

  switch (provider) {
    case 'twilio': {
      const mod = await import('./twilio.js');
      return mod.makeSimpleCall(toNumber, message);
    }
    case 'plivo': {
      const mod = await import('./plivo.js');
      return mod.makeSimpleCall(toNumber, message);
    }
    case 'telnyx': {
      const mod = await import('./telnyx.js');
      return mod.makeSimpleCall(toNumber, message);
    }
    case 'vonage': {
      const mod = await import('./vonage.js');
      return mod.makeSimpleCall(toNumber, message);
    }
    default:
      return { success: false, error: `Provedor "${provider}" não suportado` };
  }
}
