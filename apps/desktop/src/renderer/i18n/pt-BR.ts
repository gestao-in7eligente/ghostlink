import { host } from './pt-BR/host.js';
import { identity } from './pt-BR/identity.js';
import { releasePtBR } from './release.pt-BR.js';

// Source catalog: every key exists here first; en.ts must have exactly the same keys.
import { camera } from './camera.pt-BR.js';
import { chat } from './chat.pt-BR.js';
import { draw } from './draw.pt-BR.js';
import { integration } from './integration.pt-BR.js';
import { owner } from './owner.pt-BR.js';
import { profile } from './profile.pt-BR.js';
import { railway } from './railway.pt-BR.js';
import { serverUpdate } from './serverUpdate.pt-BR.js';
import { voice } from './voice.pt-BR.js';

export const messages = {
  ...releasePtBR,
  'app.loading': 'Carregando…',
  'app.beta': 'beta',

  'common.back': 'Voltar',
  'common.continue': 'Continuar',
  'common.cancel': 'Cancelar',
  'common.tryAgain': 'Tentar de novo',
  'common.comingSoon': 'Em breve',

  'language.label': 'Idioma',
  'language.pt-BR': 'Português (Brasil)',
  'language.en': 'English',

  'identityLocked.title': 'Não foi possível abrir sua identidade',
  'identityLocked.body':
    'O GhostLink encontrou sua identidade neste computador, mas o sistema não deixou decifrá-la. Isso acontece quando o acesso ao Chaveiro é negado ou quando os dados do app foram apagados ou copiados de outro computador. Nada foi apagado.',
  'identityLocked.stillLocked': 'Ainda não deu certo. Libere o acesso no sistema e tente de novo.',
  'identityLocked.import': 'Importar backup',
  'identityLocked.replace': 'Criar identidade nova',
  'identityLocked.confirm1':
    'Uma identidade nova é outra pessoa para os servidores: você perde o acesso de dono e precisa de convites de novo.',
  'identityLocked.confirm1Button': 'Quero criar uma nova',
  'identityLocked.confirm2':
    'Última confirmação. O arquivo antigo fica guardado como identity.bin.bak-… e volta a servir se o sistema conseguir decifrá-lo depois.',
  'identityLocked.confirm2Button': 'Criar identidade nova agora',

  'onboarding.welcome.title': 'Bem-vindo ao GhostLink',
  'onboarding.welcome.body':
    'Sem conta e sem cadastro: sua chave fica neste dispositivo, e cada servidor conhece uma identidade diferente sua.',
  'onboarding.welcome.start': 'Começar',
  'onboarding.profile.title': 'Como você quer ser chamado?',
  'onboarding.profile.nickname': 'Apelido',
  'onboarding.profile.nicknameHint': 'De 1 a 32 caracteres. Dá para usar outro em cada servidor.',
  'onboarding.backup.title': 'Guarde um backup da sua identidade',
  'onboarding.backup.body':
    'Sua identidade existe só neste computador. Sem backup, perder ou formatar o dispositivo é perder a identidade. Exporte um arquivo .ghostkey protegido por senha agora, ou depois em Identidade e backup.',
  'onboarding.backup.ack': 'Entendi',
  'onboarding.choose.title': 'O que você quer fazer?',
  'onboarding.choose.join': 'Entrar num servidor',
  'onboarding.choose.host': 'Hospedar um servidor',

  'join.title': 'Entrar num servidor',
  'join.input.label': 'Convite ou endereço',
  'join.input.placeholder': 'Cole o link, o código GL1-… ou host:porta',
  'join.probing': 'Lendo a identidade do servidor…',
  'join.fingerprint': 'Impressão digital',
  'join.invite.title': 'Convite para {name}',
  'join.invite.untitled': 'Convite para um servidor',
  'join.invite.nameHint': '(nome informado pelo convite)',
  'join.invite.addresses': 'Endereços',
  'join.invite.accept': 'Aceitar convite',
  'join.known.title': 'Abrindo {name}…',
  'join.known.text': 'Você já entrou neste servidor antes. Não precisa aceitar o convite de novo.',
  'join.tofu.title': 'Confira a impressão digital',
  'join.tofu.body':
    'É a primeira vez que você se conecta a {address}. Peça ao dono do servidor a impressão digital e compare os quatro grupos antes de continuar.',
  'join.tofu.confirm': 'É igual, continuar',
  'join.tofu.keyChanged':
    'Atenção: {name} usava outra chave neste endereço. Pode ser um servidor falso. Só continue se o dono confirmou que a chave mudou.',
  'join.details.title': 'Seu apelido neste servidor',
  'join.details.nickname': 'Apelido',
  'join.details.suggestion': 'Que tal {suggestion}?',
  'join.details.password': 'Senha do servidor',
  'join.details.inviteCode': 'Convite',
  'join.details.inviteCodeHint': 'Cole o link ou o código que um administrador enviou.',
  'join.details.connect': 'Conectar',
  'join.connecting': 'Conectando…',

  'connected.as': 'Você está como {nickname}',
  'connected.owner': 'Você é o dono deste servidor.',
  'connected.fingerprint': 'Impressão digital do servidor',
  'connected.version': 'Versão do servidor: {version}',
  'connected.placeholder': 'Canais e mensagens chegam na próxima etapa.',
  'connected.disconnect': 'Desconectar',
  'connected.reconnect': 'Conectar de novo',

  'state.idle': 'Desconectado',
  'state.connecting': 'Conectando…',
  'state.authenticating': 'Autenticando…',
  'state.connected': 'Conectado',
  'state.reconnecting': 'Reconectando…',
  'state.failed': 'Desconectado',

  'servers.title': 'Seus servidores',
  'servers.empty': 'Você ainda não entrou em nenhum servidor.',
  'servers.join': 'Entrar num servidor',
  'servers.connect': 'Conectar',
  'servers.remove': 'Remover',
  'servers.removeConfirm': 'Remover {name} da lista? Você continua membro e pode voltar pelo endereço.',
  'servers.as': 'como {nickname}',

  'errors.BAD_REQUEST': 'Algo nesse pedido não está certo. Confira os dados e tente de novo.',
  'errors.NOT_FOUND': 'Não encontrado.',
  'errors.FORBIDDEN': 'Você não tem permissão para isso.',
  'errors.HIERARCHY': 'Seu cargo não permite agir sobre essa pessoa ou esse cargo.',
  'errors.RATE_LIMITED': 'Muitas tentativas em pouco tempo. Espere um pouco e tente de novo.',
  'errors.INTERNAL': 'Algo deu errado. Tente de novo.',
  'errors.PROTOCOL_UNSUPPORTED': 'Este servidor usa uma versão mais nova do GhostLink. Atualize o app.',
  'errors.BAD_PASSWORD': 'Senha incorreta.',
  'errors.INVITE_REQUIRED': 'Este servidor só aceita quem tem convite.',
  'errors.INVITE_INVALID': 'Este convite não vale mais: expirou, foi revogado ou já foi usado.',
  'errors.BAD_SIGNATURE': 'O servidor não aceitou a prova da sua identidade.',
  'errors.CHALLENGE_EXPIRED': 'A conexão demorou demais. Tente de novo.',
  'errors.SERVER_FULL': 'O servidor está cheio.',
  'errors.BANNED': 'Você foi banido deste servidor.',
  'errors.REJOIN_BLOCKED': 'Você foi expulso há pouco. Espere alguns minutos para voltar.',
  'errors.NICK_TAKEN': 'Esse apelido já está em uso neste servidor.',
  'errors.BAD_SETUP_CODE': 'Código de configuração inválido.',
  'errors.SESSION_REPLACED': 'Você entrou por outro lugar, e esta sessão foi encerrada.',
  'errors.KICKED': 'Você foi expulso do servidor.',
  'errors.SERVER_SHUTDOWN': 'O servidor foi desligado.',
  'errors.CHANNEL_FULL': 'O canal está cheio.',
  'errors.FILE_TOO_LARGE': 'O arquivo é grande demais.',
  'errors.IMAGE_TOO_LARGE': 'A imagem é grande demais.',
  'errors.QUOTA_EXCEEDED': 'O servidor ficou sem espaço para arquivos.',
  'errors.BAD_ATTACHMENT': 'Anexo inválido.',
  'errors.OWNER_MUST_TRANSFER': 'Transfira a posse do servidor antes de sair.',
  'errors.PIN_MISMATCH': 'A identidade deste servidor não confere. Pode ser um servidor falso, então a conexão foi bloqueada.',
  'errors.UNREACHABLE': 'Não foi possível alcançar o servidor. Confira o endereço e a sua conexão.',
  'errors.CONNECTION_LOST': 'A conexão caiu.',
  'errors.TIMEOUT': 'O servidor parou de responder.',
  'errors.SERVER_OUTDATED': 'Este servidor está desatualizado. Avise o dono.',
  'errors.ENCRYPTION_UNAVAILABLE': 'Este sistema não oferece armazenamento seguro, então a identidade não pode ser criada.',
  'errors.IDENTITY_UNAVAILABLE': 'Sua identidade não está disponível.',
  'errors.VOICE_URL_REJECTED': 'O servidor mandou a chamada de voz para outro endereço, então ela foi bloqueada. Avise o dono do servidor.',

  ...host,
  ...identity,
  ...chat,
  ...integration,
  ...owner,
  ...voice,
  ...camera,
  ...draw,
  ...railway,
  ...profile,
  ...serverUpdate,
} as const;
