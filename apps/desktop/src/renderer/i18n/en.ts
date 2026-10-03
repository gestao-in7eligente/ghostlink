import { host } from './en/host.js';
import { identity } from './en/identity.js';
import { attachments } from './attachments.en.js';
import { bots } from './bots.en.js';
import { enterprise } from './enterprise.en.js';
import { sites } from './sites.en.js';
import { camera } from './camera.en.js';
import { chat } from './chat.en.js';
import { dm } from './dm.en.js';
import { draw } from './draw.en.js';
import { friends } from './friends.en.js';
import { integration } from './integration.en.js';
import { notifications } from './notifications.en.js';
import { owner } from './owner.en.js';
import { profile } from './profile.en.js';
import { railway } from './railway.en.js';
import type { messages as ptBR } from './pt-BR.js';
import { releaseEn } from './release.en.js';
import { serverDelete } from './serverDelete.en.js';
import { serverUpdate } from './serverUpdate.en.js';
import { tray } from './tray.en.js';
import { voice } from './voice.en.js';

// Typed against pt-BR: a missing or extra key fails the typecheck (contract §5).
export const messages: Record<keyof typeof ptBR, string> = {
  ...releaseEn,
  'app.loading': 'Loading…',
  'app.beta': 'beta',

  'common.back': 'Back',
  'common.continue': 'Continue',
  'common.cancel': 'Cancel',
  'common.tryAgain': 'Try again',
  'common.comingSoon': 'Coming soon',

  'language.label': 'Language',
  'language.pt-BR': 'Português (Brasil)',
  'language.en': 'English',

  'identityLocked.title': 'Your identity could not be opened',
  'identityLocked.body':
    'GhostLink found your identity on this computer, but the system would not decrypt it. This happens when keychain access is denied or when the app data was deleted or copied from another computer. Nothing was deleted.',
  'identityLocked.stillLocked': 'Still locked. Allow access in the system and try again.',
  'identityLocked.import': 'Import backup',
  'identityLocked.replace': 'Create a new identity',
  'identityLocked.confirm1':
    'A new identity is a different person to every server: you lose owner access and need invites again.',
  'identityLocked.confirm1Button': 'I want a new one',
  'identityLocked.confirm2':
    'Last confirmation. The old file is kept as identity.bin.bak-… and works again if the system can decrypt it later.',
  'identityLocked.confirm2Button': 'Create a new identity now',

  'onboarding.welcome.title': 'Welcome to GhostLink',
  'onboarding.welcome.body':
    'No account, no sign-up: your key stays on this device, and each server knows a different identity of yours.',
  'onboarding.welcome.start': 'Get started',
  'onboarding.profile.title': 'What should people call you?',
  'onboarding.profile.nickname': 'Nickname',
  'onboarding.profile.nicknameHint': '1 to 32 characters. You can use a different one on each server.',
  'onboarding.backup.title': 'Keep a backup of your identity',
  'onboarding.backup.body':
    'Your identity exists only on this computer. Without a backup, losing or wiping the device means losing the identity. Export a password-protected .ghostkey file now, or later in Identity and backup.',
  'onboarding.backup.ack': 'Got it',
  'onboarding.choose.title': 'What do you want to do?',
  'onboarding.choose.join': 'Join a server',
  'onboarding.choose.host': 'Host a server',

  'join.title': 'Join a server',
  'join.input.label': 'Invite or address',
  'join.input.placeholder': 'Paste the link, the GL1-… code or host:port',
  'join.probing': 'Reading the server identity…',
  'join.fingerprint': 'Fingerprint',
  'join.invite.title': 'Invite to {name}',
  'join.invite.untitled': 'Invite to a server',
  'join.invite.nameHint': '(name given by the invite)',
  'join.invite.addresses': 'Addresses',
  'join.invite.accept': 'Accept invite',
  'join.known.title': 'Opening {name}…',
  'join.known.text': 'You joined this server before. There is no need to accept the invite again.',
  'join.tofu.title': 'Check the fingerprint',
  'join.tofu.body':
    'This is your first connection to {address}. Ask the server owner for the fingerprint and compare all four groups before you continue.',
  'join.tofu.confirm': 'It matches, continue',
  'join.tofu.keyChanged':
    'Warning: {name} used a different key at this address. This may be a fake server. Only continue if the owner confirmed the key changed.',
  'join.details.title': 'Your nickname on this server',
  'join.details.nickname': 'Nickname',
  'join.details.suggestion': 'How about {suggestion}?',
  'join.details.password': 'Server password',
  'join.details.inviteCode': 'Invite',
  'join.details.inviteCodeHint': 'Paste the link or the code an admin sent you.',
  'join.details.connect': 'Connect',
  'join.connecting': 'Connecting…',

  'connected.as': 'You are {nickname}',
  'connected.owner': 'You own this server.',
  'connected.fingerprint': 'Server fingerprint',
  'connected.version': 'Server version: {version}',
  'connected.placeholder': 'Channels and messages arrive in the next milestone.',
  'connected.disconnect': 'Disconnect',
  'connected.reconnect': 'Connect again',

  'state.idle': 'Disconnected',
  'state.connecting': 'Connecting…',
  'state.authenticating': 'Authenticating…',
  'state.connected': 'Connected',
  'state.reconnecting': 'Reconnecting…',
  'state.failed': 'Disconnected',

  'servers.title': 'Your servers',
  'servers.empty': 'You have not joined any server yet.',
  'servers.join': 'Join a server',
  'servers.connect': 'Connect',
  'servers.as': 'as {nickname}',

  'errors.BAD_REQUEST': 'Something in this request is not right. Check it and try again.',
  'errors.NOT_FOUND': 'Not found.',
  'errors.FORBIDDEN': 'You are not allowed to do that.',
  'errors.HIERARCHY': 'Your role cannot act on that person or role.',
  'errors.RATE_LIMITED': 'Too many attempts. Wait a moment and try again.',
  'errors.INTERNAL': 'Something went wrong. Try again.',
  'errors.PROTOCOL_UNSUPPORTED': 'This server runs a newer GhostLink. Update the app.',
  'errors.BAD_PASSWORD': 'Wrong password.',
  'errors.INVITE_REQUIRED': 'This server only accepts people with an invite.',
  'errors.INVITE_INVALID': 'This invite is no longer valid: it expired, was revoked or was used up.',
  'errors.BAD_SIGNATURE': 'The server did not accept the proof of your identity.',
  'errors.CHALLENGE_EXPIRED': 'The connection took too long. Try again.',
  'errors.SERVER_FULL': 'The server is full.',
  'errors.BANNED': 'You are banned from this server.',
  'errors.REJOIN_BLOCKED': 'You were kicked recently. Wait a few minutes before coming back.',
  'errors.NICK_TAKEN': 'That nickname is taken on this server.',
  'errors.BAD_SETUP_CODE': 'Invalid setup code.',
  'errors.SESSION_REPLACED': 'You signed in somewhere else, so this session ended.',
  'errors.KICKED': 'You were kicked from the server.',
  'errors.SERVER_SHUTDOWN': 'The server was shut down.',
  'errors.SERVER_DELETING': 'The owner shut this server down, and it will be deleted soon.',
  'errors.SERVER_DELETED': 'This server was deleted by its owner.',
  'errors.CHANNEL_FULL': 'The channel is full.',
  'errors.FILE_TOO_LARGE': 'The file is over this server’s size limit.',
  'errors.IMAGE_TOO_LARGE': 'The image is too large: up to 8192 px a side and 40 megapixels.',
  'errors.QUOTA_EXCEEDED': 'The server is out of space for files. Tell the owner.',
  'errors.BAD_ATTACHMENT': 'The attachment is no longer valid. Try again to send it once more.',
  'errors.OWNER_MUST_TRANSFER': 'Transfer ownership of the server before leaving.',
  'errors.PIN_MISMATCH': 'This server’s identity does not match. It may be a fake server, so the connection was blocked.',
  'errors.UNREACHABLE': 'Could not reach the server. Check the address and your connection.',
  'errors.CONNECTION_LOST': 'The connection dropped.',
  'errors.TIMEOUT': 'The server stopped responding.',
  'errors.SERVER_OUTDATED': 'This server is out of date. Tell the owner.',
  'errors.ENCRYPTION_UNAVAILABLE': 'This system offers no secure storage, so an identity cannot be created.',
  'errors.IDENTITY_UNAVAILABLE': 'Your identity is not available.',
  'errors.VOICE_URL_REJECTED': 'The server sent the voice call to another address, so it was blocked. Let the server owner know.',

  ...host,
  ...identity,
  ...chat,
  ...integration,
  ...owner,
  ...voice,
  ...camera,
  ...draw,
  ...railway,
  ...friends,
  ...dm,
  ...profile,
  ...serverUpdate,
  ...serverDelete,
  ...attachments,
  ...tray,
  ...bots,
  ...enterprise,
  ...sites,
  ...notifications,
};
