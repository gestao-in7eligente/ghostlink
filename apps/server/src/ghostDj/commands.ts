import { GHOST_DJ_LIMITS, type BotCommand } from '@ghostlink/shared';
import type { TrackError } from './ytdlp.js';

/** The DJ's slash commands (spec §1), registered by the server at every start. */
export const DJ_COMMANDS: BotCommand[] = [
  {
    name: 'play',
    description: 'Toca ou põe na fila uma música do YouTube (nome, link de vídeo ou de playlist)',
    options: [{ name: 'busca', description: 'Nome da música ou link do YouTube', type: 'string', required: true }],
  },
  { name: 'pause', description: 'Pausa a música', options: [] },
  { name: 'resume', description: 'Continua a música pausada', options: [] },
  { name: 'skip', description: 'Pula para a próxima música', options: [] },
  { name: 'stop', description: 'Para, limpa a fila e sai do canal de voz', options: [] },
  { name: 'queue', description: 'Mostra a fila (só para você)', options: [] },
  { name: 'nowplaying', description: 'Mostra o que está tocando', options: [] },
  {
    name: 'volume',
    description: 'Muda o volume (0 a 100)',
    options: [{ name: 'nivel', description: 'De 0 a 100', type: 'integer', required: true }],
  },
  {
    name: 'loop',
    description: 'Repete a música, a fila ou nada',
    options: [
      {
        name: 'modo',
        description: 'O que repetir',
        type: 'string',
        required: true,
        choices: [
          { name: 'música', value: 'musica' },
          { name: 'fila', value: 'fila' },
          { name: 'desligado', value: 'desligado' },
        ],
      },
    ],
  },
];

export const DJ_NAME = 'Ghost DJ';
export const DJ_DESCRIPTION =
  'O bot de música do servidor. Entre num canal de voz e use /play com o nome de uma música ou um link do YouTube.';

/** What the DJ says. Plain chat markdown; titles go through chatText() before they get here. */
export const say = {
  unavailable: 'O Ghost DJ não está disponível neste servidor: ele precisa do ffmpeg e da voz ligada. O dono do servidor pode instalar o ffmpeg.',
  voiceDown: 'A voz deste servidor está fora do ar agora. Tente de novo daqui a pouco.',
  preparing: 'O Ghost DJ ainda está se preparando (baixando o yt-dlp). Tente de novo em um minuto.',
  notInVoice: 'Entre num canal de voz e use /play de novo.',
  invalidQuery: 'Não consigo tocar isso. Mande o nome da música ou um link do YouTube (vídeo ou playlist).',
  busy: (channel: string) => `O Ghost DJ está tocando em 🔊 ${channel}.`,
  queueFull: `A fila está cheia (${GHOST_DJ_LIMITS.maxQueue} músicas). Espere algumas tocarem ou use /skip.`,
  joinForbidden: (channel: string) => `O Ghost DJ não tem permissão para entrar e falar em 🔊 ${channel}.`,
  channelFull: (channel: string) => `🔊 ${channel} está lotado.`,
  joinFailed: 'O Ghost DJ não conseguiu entrar no canal de voz. Tente de novo.',
  notPlaying: 'O Ghost DJ não está tocando agora.',
  joinToControl: (channel: string) => `Entre em 🔊 ${channel} para controlar o Ghost DJ.`,
  nothingToSkip: 'Não tem nada tocando para pular.',
  alreadyPaused: 'A música já está pausada.',
  notPaused: 'A música não está pausada.',
  badVolume: 'O volume vai de 0 a 100.',
  badLoop: 'Escolha música, fila ou desligado.',
  failed: 'Algo deu errado. Tente de novo.',
  paused: (by: string) => `⏸️ ${by} pausou a música.`,
  resumed: (by: string) => `▶️ ${by} continuou a música.`,
  skipped: (by: string, title: string) => `⏭️ ${by} pulou **${title}**.`,
  stopped: (by: string) => `⏹️ ${by} parou o Ghost DJ.`,
  volume: (by: string, level: number) => `🔊 ${by} mudou o volume para ${level}.`,
  loop: (by: string, mode: LoopMode) => `🔁 ${by}: ${mode === 'track' ? 'repetindo a música' : mode === 'queue' ? 'repetindo a fila' : 'sem repetir'}.`,
};

export type LoopMode = 'off' | 'track' | 'queue';

export const LOOP_CHOICES: Readonly<Record<string, LoopMode>> = { musica: 'track', fila: 'queue', desligado: 'off' };

export function loopLabel(mode: LoopMode): string {
  return mode === 'track' ? 'a música' : mode === 'queue' ? 'a fila' : 'desligado';
}

/** Why a link or search could not be played, for the person who asked. */
export function trackErrorText(error: TrackError, o: { hasCookies?: boolean; query?: string } = {}): string {
  switch (error) {
    case 'blocked':
      return o.hasCookies
        ? 'O YouTube recusou o Ghost DJ mesmo com o arquivo de cookies. O dono do servidor precisa trocar o `ghost-dj/cookies.txt` por um novo.'
        : 'O YouTube bloqueou o Ghost DJ neste servidor ("Sign in to confirm you\'re not a bot", comum em servidores na nuvem). O dono do servidor pode colocar um arquivo de cookies do YouTube (formato Netscape) em `ghost-dj/cookies.txt`, na pasta de dados do servidor.';
    case 'unavailable':
      return 'Esse vídeo não está disponível (privado, removido ou com restrição de idade).';
    case 'not_found':
      return o.query ? `Não encontrei nada no YouTube para "${o.query}".` : 'Não encontrei nada no YouTube.';
    case 'live':
      return 'Transmissões ao vivo não são suportadas.';
    case 'too_long':
      return `Esse vídeo passa de ${GHOST_DJ_LIMITS.maxTrackSeconds / 3_600} horas, o máximo do Ghost DJ.`;
    case 'failed':
      return 'Não consegui ler isso no YouTube agora. Tente de novo.';
  }
}
