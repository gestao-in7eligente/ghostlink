import { describe, expect, it } from 'vitest';
import type { InteractionOption } from '@ghostlink/shared';
import { toGhostLinkCommand } from '../src/commands.js';
import {
  ApplicationCommandOptionType,
  ChannelType,
  CommandInteractionOptionResolver,
  DiscordjsTypeError,
  GhostLinkUnsupported,
  SlashCommandBuilder,
  TextChannel,
  User,
  type Client,
} from '../src/index.js';

const ANA = 'a'.repeat(32);
const GERAL = 'G'.repeat(26);

/** The two lookups the resolver makes: the server's members and channels. */
function fakeClient(): Client {
  const client = {} as Client;
  const ana = new User(client, { userId: ANA, nickname: 'Ana' });
  const geral = new TextChannel(client, { id: GERAL, name: 'geral' });
  Object.assign(client, {
    _user: (id: string) => (id === ANA ? ana : new User(client, { userId: id, nickname: 'Deleted user' })),
    _channel: (id: string) => (id === GERAL ? geral : new TextChannel(client, { id, name: '' })),
  });
  return client;
}

const OPTIONS: InteractionOption[] = [
  { name: 'texto', type: 'string', value: 'olá' },
  { name: 'vezes', type: 'integer', value: 3 },
  { name: 'fator', type: 'number', value: 1.5 },
  { name: 'privado', type: 'boolean', value: false },
  { name: 'quem', type: 'user', value: ANA },
  { name: 'onde', type: 'channel', value: GERAL },
];

describe('interaction.options getters', () => {
  const options = new CommandInteractionOptionResolver(fakeClient(), OPTIONS);

  it('return each value with its discord.js type', () => {
    expect(options.getString('texto')).toBe('olá');
    expect(options.getInteger('vezes')).toBe(3);
    expect(options.getNumber('fator')).toBe(1.5);
    expect(options.getBoolean('privado')).toBe(false);
    expect(options.getUser('quem')).toMatchObject({ id: ANA, username: 'Ana', bot: false });
    expect(options.getUser('quem')!.toString()).toBe(`<@${ANA}>`);
    expect(options.getChannel('onde')).toMatchObject({ id: GERAL, name: 'geral', type: ChannelType.GuildText });
    expect(options.get('vezes')).toEqual({ name: 'vezes', type: ApplicationCommandOptionType.Integer, value: 3 });
    expect(options.data).toHaveLength(6);
  });

  it('return null for an option not given, and throw when it is required', () => {
    expect(options.getString('nada')).toBeNull();
    expect(options.getUser('nada')).toBeNull();
    expect(() => options.getString('nada', true)).toThrow(DiscordjsTypeError);
    expect(() => options.getString('nada', true)).toThrow('Required option "nada" not found.');
  });

  it('throw for an option of another type, as discord.js does', () => {
    expect(() => options.getString('vezes')).toThrow('Option "vezes" is of type: Integer; expected String.');
    expect(() => options.getInteger('fator')).toThrow(expect.objectContaining({ code: 'CommandInteractionOptionType' }));
    expect(() => options.getChannel('onde', true, [ChannelType.GuildVoice])).toThrow(DiscordjsTypeError);
  });

  it('throw GhostLinkUnsupported for what GhostLink commands cannot carry', () => {
    // Not in the types either: plain JavaScript bots reach them.
    const untyped = options as unknown as { getMember(name: string): unknown; getSubcommand(): string };
    expect(() => untyped.getMember('quem')).toThrow(GhostLinkUnsupported);
    expect(() => untyped.getSubcommand()).toThrow('CommandInteractionOptionResolver.getSubcommand is not supported on GhostLink');
  });
});

describe('SlashCommandBuilder options → GhostLink commands.set', () => {
  it('maps every supported option type, required flags and choices', () => {
    const command = new SlashCommandBuilder()
      .setName('dado')
      .setDescription('Rola um dado')
      .addIntegerOption((o) => o.setName('lados').setDescription('Quantos lados').setRequired(true).addChoices({ name: 'D6', value: 6 }, { name: 'D20', value: 20 }))
      .addStringOption((o) => o.setName('nome').setDescription('Quem rola'))
      .addNumberOption((o) => o.setName('bonus').setDescription('Bônus'))
      .addBooleanOption((o) => o.setName('secreto').setDescription('Só você vê'))
      .addUserOption((o) => o.setName('para').setDescription('Para quem'))
      .addChannelOption((o) => o.setName('canal').setDescription('Onde'));
    expect(toGhostLinkCommand(command)).toEqual({
      name: 'dado',
      description: 'Rola um dado',
      options: [
        { name: 'lados', description: 'Quantos lados', type: 'integer', required: true, choices: [{ name: 'D6', value: 6 }, { name: 'D20', value: 20 }] },
        { name: 'nome', description: 'Quem rola', type: 'string', required: false },
        { name: 'bonus', description: 'Bônus', type: 'number', required: false },
        { name: 'secreto', description: 'Só você vê', type: 'boolean', required: false },
        { name: 'para', description: 'Para quem', type: 'user', required: false },
        { name: 'canal', description: 'Onde', type: 'channel', required: false },
      ],
    });
  });

  it('refuses what GhostLink would silently drop', () => {
    expect(() => toGhostLinkCommand({ name: 'x', description: 'y', options: [{ type: ApplicationCommandOptionType.Role, name: 'r', description: 'd' }] })).toThrow(GhostLinkUnsupported);
    expect(() => toGhostLinkCommand({ name: 'x', description: 'y', default_member_permissions: '8' })).toThrow(GhostLinkUnsupported);
    expect(() => toGhostLinkCommand({ name: 'x', description: 'y', options: [{ type: 3, name: 'a', description: 'b', min_length: 2 }] })).toThrow(GhostLinkUnsupported);
    expect(() => new SlashCommandBuilder().setName('Ping')).toThrow(RangeError);
  });
});
