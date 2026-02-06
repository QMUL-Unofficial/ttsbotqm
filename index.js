require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, ChannelType } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  generateDependencyReport
} = require('@discordjs/voice');
const say = require('say');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

// ==== Config ====
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const TARGET_TEXT_CHANNEL_ID = process.env.TARGET_TEXT_CHANNEL_ID || '1436742855275057262';
const VOICE_NAME = process.env.VOICE_NAME || 'Samantha';
const FIXED_VC_ID = process.env.FIXED_VOICE_CHANNEL_ID || null; // set to force a specific VC

if (!TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN in .env');
  process.exit(1);
}

// ==== Client ====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ==== Voice state ====
let connection = null;
const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
});

player.on('error', (e) => console.error('Audio player error:', e));
// player.on('stateChange', (o, n) => console.log('Player:', o.status, '->', n.status));

// ==== Helpers ====
function cleanText(str) {
  if (!str) return '';
  return str
    .replace(/<@[!&]?\d+>/g, 'someone')        // @mentions
    .replace(/<#\d+>/g, 'a channel')           // #channel mentions
    .replace(/<a?:\w+:\d+>/g, '')              // custom emoji
    .replace(/https?:\/\/\S+/g, 'a link')      // URLs
    .replace(/\s+/g, ' ')                      // collapse whitespace
    .trim();
}

async function ensureJoinedVC(memberOrGuild) {
  let vc = null;

  if (FIXED_VC_ID) {
    const guild = 'guild' in memberOrGuild ? memberOrGuild.guild : memberOrGuild;
    vc = guild.channels.cache.get(FIXED_VC_ID) || await guild.channels.fetch(FIXED_VC_ID).catch(() => null);
    if (!vc || (vc.type !== ChannelType.GuildVoice && vc.type !== ChannelType.GuildStageVoice)) {
      console.warn('FIXED_VOICE_CHANNEL_ID is not a voice/stage channel or not found.');
      return null;
    }
  } else {
    const member = memberOrGuild;
    vc = member?.voice?.channel;
    if (!vc) return null;
  }

  if (connection && connection.joinConfig.channelId === vc.id) return connection;

  connection = joinVoiceChannel({
    channelId: vc.id,
    guildId: vc.guild.id,
    adapterCreator: vc.guild.voiceAdapterCreator,
    selfDeaf: true,   // we don't need to listen
    selfMute: false   // must be false to speak
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    connection.subscribe(player);

    // Unsuppress on Stage channels so we can speak
    if (vc.type === ChannelType.GuildStageVoice) {
      const me = vc.guild.members.me;
      if (me?.voice?.suppress) {
        me.voice.setSuppressed(false).catch(() => {});
      }
    }
    return connection;
  } catch (e) {
    console.error('Failed to hit Ready state:', e);
    try { connection.destroy(); } catch {}
    connection = null;
    return null;
  }
}

// macOS: say -> CAF -> afconvert -> WAV (48kHz 16-bit LE PCM)
async function ttsToWav(text) {
  const base = `tts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const cafPath = path.join(os.tmpdir(), `${base}.caf`);
  const wavPath = path.join(os.tmpdir(), `${base}.wav`);

  try { fs.unlinkSync(cafPath); } catch {}
  try { fs.unlinkSync(wavPath); } catch {}

  await new Promise((resolve, reject) => {
    say.export(text, VOICE_NAME, 1.0, cafPath, (err) => (err ? reject(err) : resolve()));
  });

  try {
    await execFileAsync('/usr/bin/afconvert', [
      '-f', 'WAVE',
      '-d', 'LEI16@48000',
      cafPath,
      wavPath
    ]);
  } catch (err) {
    console.error('afconvert error:', err.stderr || err.message || err);
    try { fs.unlinkSync(cafPath); } catch {}
    throw err;
  }

  try { fs.unlinkSync(cafPath); } catch {}
  return wavPath;
}

const queue = [];
let isSpeaking = false;

async function speak(text) {
  const MAX_LEN = 400;
  const clipped = text.length > MAX_LEN ? text.slice(0, MAX_LEN) + ' …' : text;

  queue.push(clipped);
  if (isSpeaking) return;
  isSpeaking = true;

  while (queue.length) {
    const next = queue.shift();
    let wavPath;
    try {
      wavPath = await ttsToWav(next);
      const resource = createAudioResource(wavPath);
      player.play(resource);
      await new Promise((resolve) => {
        const onIdle = () => { player.off(AudioPlayerStatus.Idle, onIdle); resolve(); };
        player.on(AudioPlayerStatus.Idle, onIdle);
      });
    } catch (e) {
      console.error('TTS/play error:', e);
    } finally {
      if (wavPath) fs.unlink(wavPath, () => {});
    }
  }

  isSpeaking = false;
}

// ==== Ready & command registration ====
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { console.log(generateDependencyReport()); } catch {}

  try {
    const guilds = await client.guilds.fetch();
    for (const [, g] of guilds) {
      const guild = await g.fetch();
      await guild.commands.create({ name: 'join', description: 'Join your current voice channel (or fixed VC) and start reading.' });
      await guild.commands.create({ name: 'leave', description: 'Leave the voice channel.' });
      await guild.commands.create({
        name: 'say',
        description: 'Make the bot speak a custom message.',
        options: [{ name: 'text', type: 3, description: 'What to say', required: true }]
      });
    }
  } catch (e) {
    console.warn('Slash command registration issue:', e.message);
  }
});

// ==== Slash commands ====
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'join') {
    const ok = await ensureJoinedVC(FIXED_VC_ID ? interaction.guild : interaction.member);
    if (ok) return interaction.reply({ content: `Joined <#${ok.joinConfig.channelId}>. Reading messages from <#${TARGET_TEXT_CHANNEL_ID}>.`, ephemeral: true });
    return interaction.reply({ content: 'Join a voice channel first (or set FIXED_VOICE_CHANNEL_ID), then use /join.', ephemeral: true });
  }

  if (interaction.commandName === 'leave') {
    if (connection) {
      try { connection.destroy(); } catch {}
      connection = null;
      return interaction.reply({ content: 'Left the voice channel.', ephemeral: true });
    }
    return interaction.reply({ content: 'I am not in a voice channel.', ephemeral: true });
  }

  if (interaction.commandName === 'say') {
    const text = interaction.options.getString('text', true);
    const ok = connection || await ensureJoinedVC(FIXED_VC_ID ? interaction.guild : interaction.member);
    if (!ok) return interaction.reply({ content: 'Join a voice channel first (or set FIXED_VOICE_CHANNEL_ID), then try /say again.', ephemeral: true });
    await interaction.reply({ content: 'Speaking your message…', ephemeral: true });
    await speak(cleanText(text));
  }
});

// ==== Read from target text channel ====
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.GuildText) return;
  if (message.channel.id !== TARGET_TEXT_CHANNEL_ID) return;

  // Ignore commands like !something or /something
  if (/^[!/]/.test(message.content)) return;

  const ok = connection || await ensureJoinedVC(FIXED_VC_ID ? message.guild : message.member);
  if (!ok) return; // nowhere to speak

  const display = message.member?.displayName || message.author.username;
  const content = cleanText(message.content);
  if (!content) return;

  const toSay = `${display} said: ${content}`;
  console.log('Speaking:', toSay);
  await speak(toSay);
});

client.login(TOKEN);
