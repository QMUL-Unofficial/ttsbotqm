/**
 * Railway-safe Discord TTS Voice Bot
 * - Joins voice via /join (or fixed voice channel via env)
 * - Reads messages from a target text channel and speaks them in VC
 * - /say speaks custom text
 *
 * Requirements:
 * - ffmpeg installed on host (we add via nixpacks.toml)
 * - google-tts-api for MP3 TTS
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

const googleTTS = require("google-tts-api");

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  demuxProbe,
  generateDependencyReport,
} = require("@discordjs/voice");

// =====================
// ENV / CONFIG
// =====================
const TOKEN = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN; // accept either
const TARGET_TEXT_CHANNEL_ID = process.env.TARGET_TEXT_CHANNEL_ID; // REQUIRED for auto-reading
const FIXED_VC_ID = process.env.FIXED_VOICE_CHANNEL_ID || null; // optional
const TTS_LANG = process.env.TTS_LANG || "en";
const MAX_LEN = Number(process.env.TTS_MAX_LEN || 400);
const SPEAK_PREFIX = process.env.SPEAK_PREFIX || ""; // optional prefix before each spoken line

// Optional: Register slash commands to a single guild for instant updates
const GUILD_ID = process.env.GUILD_ID || null;

if (!TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN (or DISCORD_TOKEN) in environment variables.");
  process.exit(1);
}
if (!TARGET_TEXT_CHANNEL_ID) {
  console.error("Missing TARGET_TEXT_CHANNEL_ID in environment variables.");
  process.exit(1);
}

// =====================
// DISCORD CLIENT
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// =====================
// VOICE SETUP
// =====================
let connection = null;

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
});

player.on("error", (e) => console.error("Audio player error:", e));

// =====================
// HELPERS
// =====================
function cleanText(str) {
  if (!str) return "";
  return str
    .replace(/<@[!&]?\d+>/g, "someone") // mentions
    .replace(/<#\d+>/g, "a channel") // channel mentions
    .replace(/<a?:\w+:\d+>/g, "") // custom emoji
    .replace(/https?:\/\/\S+/g, "a link") // URLs
    .replace(/\s+/g, " ")
    .trim();
}

function downloadToFile(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);

    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close(() => {});
          try { fs.unlinkSync(outPath); } catch {}
          return reject(new Error(`TTS HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        file.close(() => {});
        try { fs.unlinkSync(outPath); } catch {}
        reject(err);
      });
  });
}

async function ttsToMp3(text) {
  const base = `tts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const mp3Path = path.join(os.tmpdir(), `${base}.mp3`);

  const url = googleTTS.getAudioUrl(text, {
    lang: TTS_LANG,
    slow: false,
    host: "https://translate.google.com",
  });

  await downloadToFile(url, mp3Path);
  return mp3Path;
}

async function ensureJoinedVC(memberOrGuild) {
  let vc = null;

  if (FIXED_VC_ID) {
    const guild = "guild" in memberOrGuild ? memberOrGuild.guild : memberOrGuild;
    vc =
      guild.channels.cache.get(FIXED_VC_ID) ||
      (await guild.channels.fetch(FIXED_VC_ID).catch(() => null));

    if (!vc || (vc.type !== ChannelType.GuildVoice && vc.type !== ChannelType.GuildStageVoice)) {
      console.warn("FIXED_VOICE_CHANNEL_ID is not a voice/stage channel or not found.");
      return null;
    }
  } else {
    const member = memberOrGuild;
    vc = member?.voice?.channel;
    if (!vc) return null;
  }

  if (connection && connection.joinConfig.channelId === vc.id) return connection;

  // If an old connection exists, destroy it
  try {
    if (connection) connection.destroy();
  } catch {}
  connection = null;

  connection = joinVoiceChannel({
    channelId: vc.id,
    guildId: vc.guild.id,
    adapterCreator: vc.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    connection.subscribe(player);

    // Unsuppress if stage channel
    if (vc.type === ChannelType.GuildStageVoice) {
      const me = vc.guild.members.me;
      if (me?.voice?.suppress) {
        me.voice.setSuppressed(false).catch(() => {});
      }
    }
    return connection;
  } catch (e) {
    console.error("Failed to hit Ready state:", e);
    try { connection.destroy(); } catch {}
    connection = null;
    return null;
  }
}

// =====================
// SPEAK QUEUE
// =====================
const queue = [];
let isSpeaking = false;

async function speak(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return;

  const clipped =
    cleaned.length > MAX_LEN ? cleaned.slice(0, MAX_LEN) + " …" : cleaned;

  queue.push(clipped);
  if (isSpeaking) return;
  isSpeaking = true;

  while (queue.length) {
    const next = queue.shift();
    let mp3Path = null;

    try {
      mp3Path = await ttsToMp3(next);

      // demuxProbe detects stream type for discord voice
      const readStream = fs.createReadStream(mp3Path);
      const { stream, type } = await demuxProbe(readStream);

      const resource = createAudioResource(stream, { inputType: type });
      player.play(resource);

      await new Promise((resolve) => {
        const onIdle = () => {
          player.off(AudioPlayerStatus.Idle, onIdle);
          resolve();
        };
        player.on(AudioPlayerStatus.Idle, onIdle);
      });
    } catch (e) {
      console.error("TTS/play error:", e);
    } finally {
      if (mp3Path) {
        fs.unlink(mp3Path, () => {});
      }
    }
  }

  isSpeaking = false;
}

// =====================
// SLASH COMMANDS
// =====================
const slashCommands = [
  new SlashCommandBuilder().setName("join").setDescription("Join your current voice channel (or fixed VC) and start reading."),
  new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel."),
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Make the bot speak a custom message.")
    .addStringOption((opt) =>
      opt.setName("text").setDescription("What to say").setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
        body: slashCommands,
      });
      console.log(`Registered slash commands to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), {
        body: slashCommands,
      });
      console.log("Registered global slash commands (can take time to appear).");
    }
  } catch (e) {
    console.warn("Slash command registration failed:", e?.message || e);
  }
}

// =====================
// EVENTS
// =====================
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    console.log(generateDependencyReport());
  } catch {}

  await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "join") {
    const ok = await ensureJoinedVC(FIXED_VC_ID ? interaction.guild : interaction.member);
    if (ok) {
      return interaction.reply({
        content: `Joined <#${ok.joinConfig.channelId}>. Reading from <#${TARGET_TEXT_CHANNEL_ID}>.`,
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: "Join a voice channel first (or set FIXED_VOICE_CHANNEL_ID), then use /join.",
      ephemeral: true,
    });
  }

  if (interaction.commandName === "leave") {
    if (connection) {
      try { connection.destroy(); } catch {}
      connection = null;
      return interaction.reply({ content: "Left the voice channel.", ephemeral: true });
    }
    return interaction.reply({ content: "I am not in a voice channel.", ephemeral: true });
  }

  if (interaction.commandName === "say") {
    const text = interaction.options.getString("text", true);
    const ok = connection || (await ensureJoinedVC(FIXED_VC_ID ? interaction.guild : interaction.member));
    if (!ok) {
      return interaction.reply({
        content: "Join a voice channel first (or set FIXED_VOICE_CHANNEL_ID), then try /say again.",
        ephemeral: true,
      });
    }

    await interaction.reply({ content: "Speaking…", ephemeral: true });
    await speak(`${SPEAK_PREFIX}${text}`);
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.GuildText) return;
    if (message.channel.id !== TARGET_TEXT_CHANNEL_ID) return;

    // ignore commands like !something or /something
    if (/^[!/]/.test(message.content)) return;

    const ok = connection || (await ensureJoinedVC(FIXED_VC_ID ? message.guild : message.member));
    if (!ok) return;

    const display = message.member?.displayName || message.author.username;
    const content = cleanText(message.content);
    if (!content) return;

    const toSay = `${SPEAK_PREFIX}${display} said: ${content}`;
    console.log("Speaking:", toSay);
    await speak(toSay);
  } catch (e) {
    console.error("Message handler error:", e);
  }
});

client.login(TOKEN);
