// voice.js — pluggable text-to-speech (ElevenLabs) and speech-to-text
// (OpenAI Whisper) for the daily huddle.
//
// Both are optional, same philosophy as mailer.js's email fallback: without
// ELEVENLABS_API_KEY, huddle lines are still generated and readable as
// text, just not spoken. Without OPENAI_API_KEY, the huddle falls back to a
// typed update instead of a recorded one. Neither key is required for the
// rest of the app — ticket work, chat, and everything else — to work.

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// A handful of ElevenLabs' own premade voices — these IDs exist on every
// ElevenLabs account with no cloning or setup required, just an API key.
// Loosely mapped by persona tone. Override any single one with
// ELEVENLABS_VOICE_<AGENTKEY> in .env if you'd rather use a custom/cloned
// voice for that character.
const DEFAULT_VOICE_MAP = {
  pm: 'EXAVITQu4vr4xnSDxMaL',        // Bella — warm
  stake: 'TxGEqnHWrfWFTfGW9XjX',     // Josh — brisk
  qa: 'VR6AewLTigWG4xSOukaG',        // Arnold — flat, technical
  tlead: 'pNInz6obpgDQGcFmaJgB',     // Adam — direct
  ceo: '21m00Tcm4TlvDq8ikWAM',       // Rachel — composed
  cto: 'ErXwobaYiN019PkySvjV',       // Antoni — measured
  dirproduct: 'MF3mGyEYCl7XYWbV9V6O', // Elli
  design: 'AZnzlk1XvdvUeBnXmlld',    // Domi
  marketing: 'ThT5KcBeYPX3keUQqHPh', // Dorothy
  sales: 'yoZ06aMxZJJ28mfd3POQ'      // Sam
};

function voiceIdFor(agentKey) {
  const envOverride = process.env['ELEVENLABS_VOICE_' + agentKey.toUpperCase()];
  return envOverride || DEFAULT_VOICE_MAP[agentKey] || DEFAULT_VOICE_MAP.pm;
}

function ttsEnabled() { return !!ELEVENLABS_API_KEY; }
function sttEnabled() { return !!OPENAI_API_KEY; }

async function synthesizeSpeech(agentKey, text) {
  if (!ttsEnabled()) {
    const e = new Error('Voice is not configured on this server (ELEVENLABS_API_KEY unset).');
    e.status = 501;
    throw e;
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceIdFor(agentKey)}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS error ${res.status}: ${errBody.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function transcribeAudio(buffer, mimeType) {
  if (!sttEnabled()) {
    const e = new Error('Voice input is not configured on this server (OPENAI_API_KEY unset).');
    e.status = 501;
    throw e;
  }
  const ext = mimeType && mimeType.includes('mp4') ? 'mp4' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), `update.${ext}`);
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Whisper transcription error ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.text || '';
}

module.exports = { ttsEnabled, sttEnabled, voiceIdFor, synthesizeSpeech, transcribeAudio };
