// --- Imports ---
import {
  type Channel,
  Client,
  Events,
  GatewayIntentBits,
  Guild,
} from "discord.js";
import fs from "fs";
import { google } from "googleapis";
import path from "path";
import { authorizeGoogle } from "./index-google";

// --- Type Definitions ---
type ChannelConfig = {
  id: string;
  bounds: {
    lat: { min: number; max: number };
    lng: { min: number; max: number };
  };
};
type Submission = {
  user: string;
  id: number;
  lat: string;
  lng: string;
  trial: boolean;
  team: string;
  field?: boolean;
  road?: boolean;
  error: false;
};

type SubmissionInput = {
  user: string;
  ids: number[];
  lat: string;
  lng: string;
  trial: boolean;
  team: string;
  field?: boolean;
  road?: boolean;
};

type SubmissionError = {
  error: true;
  message: string;
  userError?: string;
};

// --- Config & State ---
const config = require("./config.json");
const channels = new Map<string, string>(); // channel ID -> team name
const channels2 = new Map<string, string>(); // team name -> channel ID
const channelBounds = new Map<string, ChannelConfig["bounds"]>(); // channel ID -> bounds
const lastSubmissionId = new Map<string, number>(); // team -> last id
const submissionCache = new Map<string, Submission[]>(); // team -> submissions
config.submit_channels.forEach((ch: any) => {
  // Will set the name in the ready event, as we need the Discord channel object
  channelBounds.set(ch.id, ch.bounds);
  lastSubmissionId.set(ch.id, ch.base_id || 0); // Initialize last ID for each channel
});
let logChannel: Channel | null | undefined = null;

// --- Discord Client Setup ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
  ],
});

// --- Ready Event ---
client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  // Set channel names in the channels map using Discord channel name
  for (const ch of config.submit_channels) {
    const discordChannel = client.channels.cache.get(ch.id);
    if (discordChannel && "name" in discordChannel) {
      channels.set(ch.id, (discordChannel as any).name);
      channels2.set((discordChannel as any).name, ch.id);
    } else {
      channels.set(ch.id, ch.id); // fallback to ID if name not found
      channels2.set(ch.id, ch.id); // fallback to ID if name not found
    }
    console.log(
      `Submit: ${ch.id} -> ${channels.get(ch.id)}; Base ID: #${ch.base_id}`
    );
  }
  logChannel = client.channels.cache.get(config.log_channel);
  console.log("-------------------------------");
});

// --- Message Handler ---
client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages and messages outside guilds
  if (message.author.bot || !message.guild) return;
  if (!channels.has(message.channel.id)) return;

  const team = channels.get(message.channel.id);
  if (!team) return;
  const bounds = channelBounds.get(message.channel.id);

  console.log(`Message in ${team}: ${message.content}`);

 // Handle Resubmission Requests
  if (message.content.toLowerCase().includes("resubmit")) {
    let channelId = config.rejudge_channel;
    if (!channelId) {channelId = config.log_channel;}

    const channel = client.channels.cache.get(channelId);

    if (
      channel &&
      "send" in channel &&
      typeof channel.send === "function"
    ) {
      await channel.send(
       `Rejudge request from ${message.author.username} in ${team}:\n\`\`\`${message.content.replace("resubmit","").replace("[","").replace("]","")}\`\`\``
      );
      await message.react("✅").catch(console.error);
      console.log(
        `Rejudge request sent to ${channelId} from ${message.author.username} in ${team}`
      );
      return;
    }
  }

  // Parse and validate submission input
  const parsed = parseSubmission(
    message.content,
    message.author.username,
    team
  );
  if ("error" in parsed && parsed.error) {
    console.log(
      `Invalid submission format in channel ${team}: ${parsed.message}`
    );
    await message.react("❌").catch(console.error);
    const replyMsg = await message.reply(
      (parsed.userError ||
        "Your submission format is invalid. Please ensure it follows the correct format.") +
        "\n\nPlease delete your message and try again with the correct format."
    );
    setTimeout(() => {
      replyMsg.delete().catch(() => {});
    }, 5 * 60 * 1000);
    return;
  }

  const input = parsed as SubmissionInput;
  const lastId = lastSubmissionId.get(message.channel.id) ?? 0;
  // Expand to individual submissions
  const submissions: Submission[] = input.ids.map((id) => ({
    user: input.user,
    id,
    lat: input.lat,
    lng: input.lng,
    trial: input.trial,
    team: input.team,
    field: input.field,
    road: input.road,
    error: false,
  }));
  // Enforce strict consecutive IDs
  if (
    submissions.length === 0 ||
    !submissions[0] ||
    submissions[0].id !== lastId + 1
  ) {
    await message.react("❌").catch(console.error);
    const replyMsg = await message.reply({
      content: `Submission ID must be exactly 1 greater than your previous submission (last: ${lastId}).`,
      embeds: [
        {
          title: "Example Submission",
          description: `#<id> <lat>, <lng> [trial] [road] [field]\n\n**Example:**\n #${
            lastId + 1
          } 37.7749 -122.4194 road\n #${
            lastId + 1
          } 37.7749 -122.4194 field\n #${
            lastId + 1
          } 37.7749 -122.4194 trial\n\n-# Supports ID ranges like #100-110`,
          color: 0xff0000, // Red for error
        },
        {
          title: "Example Resubmission",
          description: `#<id> [resubmit]\n\n**Example:**\n #${
            lastId + 1
          } resubmit
          -# Supports ID ranges like #100-110`,
          color: 0xff0000, // Red for error
        },
      ],
    });
    setTimeout(() => {
      replyMsg.delete().catch(() => {});
    }, 5 * 60 * 1000);
    return;
  }

  if (submissions.length > 20) {
    await message.react("❌").catch(console.error);
    await message.reply(
      `Please only submit up to 20 submissions at once. Split your submissions into smaller batches.`
    );
    return;
  }

  for (let i = 1; i < submissions.length; ++i) {
    if (!submissions[i] || !submissions[i - 1]) {
      await message.react("❌").catch(console.error);
      const replyMsg = await message.reply(
        `Submission IDs must be consecutive. (Internal error: missing submission object)`
      );
      setTimeout(() => {
        replyMsg.delete().catch(() => {});
      }, 5 * 60 * 1000);
      return;
    }
    if (submissions[i]!.id !== submissions[i - 1]!.id + 1) {
      await message.react("❌").catch(console.error);
      const replyMsg = await message.reply(
        `Submission IDs must be consecutive. Found gap between #${
          submissions[i - 1]!.id
        } and #${submissions[i]!.id}.`
      );
      setTimeout(() => {
        replyMsg.delete().catch(() => {});
      }, 5 * 60 * 1000);
      return;
    }
  }

  // Check coordinates are in bounds for the input (not all submissions)
  if (bounds) {
    const lat = parseFloat(input.lat);
    const lng = parseFloat(input.lng);
    if (
      isNaN(lat) ||
      isNaN(lng) ||
      lat < bounds.lat.min ||
      lat > bounds.lat.max ||
      lng < bounds.lng.min ||
      lng > bounds.lng.max
    ) {
      await message.react("❌").catch(console.error);
      const replyMsg = await message.reply(
        `Coordinates out of bounds for this channel. Latitude must be between ${bounds.lat.min} and ${bounds.lat.max}, longitude between ${bounds.lng.min} and ${bounds.lng.max}.`
      );
      setTimeout(() => {
        replyMsg.delete().catch(() => {});
      }, 5 * 60 * 1000);
      return;
    }
  }

  // Store submissions
  let currentId = lastId;
  if (!submissionCache.has(team)) {
    submissionCache.set(team, []);
  }
  const cache = submissionCache.get(team)!;
  for (const submission of submissions) {
    cache.push(submission);
    currentId = submission.id;
    // Log to log channel if available
    if (
      logChannel &&
      "send" in logChannel &&
      typeof logChannel.send === "function"
    ) {
      logChannel.send(
        `➕ ${team}: #${submission.id} by ${submission.user} (${
          submission.lat
        }, ${submission.lng})${submission.trial ? " [Trial]" : ""}${
          submission.field ? " [Field]" : ""
        }${submission.road ? " [Road]" : ""}`
      );
    }
  }
  lastSubmissionId.set(message.channelId, currentId);

  await message.react("✅").catch(console.error);
  console.log(
    `Submission(s) added to cache for channel ${team}. Total submissions: ${cache.length}`
  );
});

// --- CSV Saving ---
async function saveCache() {
  // Update config.submit_channels[].base_id with the last submission id for each channel
  for (const ch of config.submit_channels) {
    const lastId = lastSubmissionId.get(ch.id) ?? ch.base_id ?? 0;
    ch.base_id = lastId;
  }
  // Save updated config back to config.json
  fs.writeFileSync(
    path.join(__dirname, "config.json"),
    JSON.stringify(config, null, 4),
    "utf8"
  );

  let hasSubmissions = false;
  const rows: string[] = [
    "team,id,round,lat,lng,user,reviewer,size,road,field,complexity,quality,hindrances,trial,2x",
  ];

  const rowsForSheet: { values: string[][]; range: string }[] = [];

  for (const [team, submissions] of submissionCache.entries()) {
    if (submissions.length > 0) hasSubmissions = true;
    if (submissions.length === 0) continue;

    // Construct values for Google Sheets
    const sheetValues = constructSheetValues(team, submissions);
    rowsForSheet.push(sheetValues);

    for (const sub of submissions) {
      rows.push(
        `${team},${sub.id},${config.current_round},${sub.lat},${sub.lng},${
          sub.user
        },,${sub.road || sub.field ? "n" : ""},${sub.road ? "y" : "n"},${
          sub.field ? "y" : "n"
        },,,n,${sub.trial ? "y" : "n"},n`
      );
    }
  }

  if (!hasSubmissions) return;

  const csvRows = rows.join("\n");
  const exportsDir = path.join(__dirname, "exports");
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }
  const fileName = `submissions-${new Date()
    .toISOString()
    .replaceAll(":", "_")}.csv`;
  const fullDir = path.join(exportsDir, fileName);
  fs.writeFileSync(fullDir, csvRows, "utf8");

  console.log(`Saved cache to ${fullDir}`);

  const auth = await authorizeGoogle();
  if (!auth) {
    console.error("Failed to authorize Google API");
    return;
  }
  const sheets = google.sheets({ version: "v4", auth: auth as any });

  const googleSheetsResult = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.spreadsheet_id,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: rowsForSheet.map((shV) => ({
        range: shV.range,
        values: shV.values,
      })),
    },
  });
  console.log(`Updated Google Sheets: ${googleSheetsResult.data.totalUpdatedRows} rows`);

  if (
    logChannel &&
    "send" in logChannel &&
    typeof logChannel.send === "function"
  ) {
    logChannel.send({
      files: [{ attachment: fullDir, name: fileName }],
      content: `Cache saved to ${fileName}`,
    });
  }
  // Clear the cache after saving
  for (const team of submissionCache.keys()) {
    submissionCache.set(team, []);
  }
}
setInterval(saveCache, 60 * 60 * 1000); // Save every 1h

// --- Error Handling ---
client.on(Events.Error, (error) => {
  console.error("An error occurred:", error);
});

// --- Bot Login ---
client.login(process.env.BOT_TOKEN);

// --- Parsing and Validation ---
function parseSubmission(
  message: string,
  user: string,
  team: string
): SubmissionInput | SubmissionError {
  let trial = false;
  let road = false;
  let field = false;
  let cleaned = message.trim();

  if (/\btrial\b|\[trial\]$/i.test(cleaned)) {
    trial = true;
    cleaned = cleaned.replace(/\[?trial\]?/gi, "").trim();
  }
  if (/\broad\b|\[road\]$/i.test(cleaned)) {
    road = true;
    cleaned = cleaned.replace(/\[?road\]?/gi, "").trim();
  }
  if (/\bfield\b|\[field\]$/i.test(cleaned)) {
    field = true;
    cleaned = cleaned.replace(/\[?field\]?/gi, "").trim();
  }
  if (/\barea\b|\[area\]$/i.test(cleaned)) {
    field = true;
    cleaned = cleaned.replace(/\[?area\]?/gi, "").trim();
  }

  // Support #400-410 <lat> <lng> for ranges
  let idPart = "";
  let rest = "";
  let match = cleaned.match(/^#?\s*(\d+)(?:\s*-\s*(\d+))?,?\s*(.*)$/i);
  if (match && typeof match[1] === "string" && typeof match[3] === "string") {
    idPart = match[1].trim();
    rest = match[3].trim();
    const startId = parseInt(idPart);
    const endId = match[2] ? parseInt(match[2]) : startId;
    if (isNaN(startId) || isNaN(endId) || endId < startId) {
      return {
        error: true,
        message: "Invalid ID range",
        userError: "Invalid ID range. Use #start-end with start <= end.",
      };
    }
    let lat = "",
      lng = "";
    let coordsMatch = rest.match(/(-?\d+(\.\d+)?)[, ]+(-?\d+(\.\d+)?)/);
    if (
      coordsMatch &&
      typeof coordsMatch[1] === "string" &&
      typeof coordsMatch[3] === "string"
    ) {
      lat = coordsMatch[1];
      lng = coordsMatch[3];
    } else {
      return {
        error: true,
        message: "Invalid coordinates",
        userError:
          "Couldn't parse the coordinates of your submission. Please ensure they are in the format 'latitude, longitude' or 'latitude longitude'.",
      };
    }
    const ids: number[] = [];
    for (let id = startId; id <= endId; ++id) {
      ids.push(id);
    }
    return { user, ids, lat, lng, trial, team, road, field };
  } else {
    // fallback to single id
    match = cleaned.match(/^#?\s*((?::[a-z]+: ?)+|\d+),?\s*(.*)$/i);
    if (match && typeof match[1] === "string" && typeof match[2] === "string") {
      idPart = match[1].trim();
      rest = match[2].trim();
    } else {
      match = cleaned.match(/^(\d+),?\s*(.*)$/);
      if (
        match &&
        typeof match[1] === "string" &&
        typeof match[2] === "string"
      ) {
        idPart = match[1].trim();
        rest = match[2].trim();
      } else {
        return {
          error: true,
          message: "Invalid submission format",
          userError:
            "Couldn't parse the ID of your submission. Please ensure it starts with a number or # followed by a number.",
        };
      }
    }
    const id = parseInt(idPart);
    if (isNaN(id))
      return {
        error: true,
        message: "Invalid ID",
        userError:
          "Couldn't parse the ID of your submission. Please ensure it starts with a number or # followed by a number.",
      };
    let lat = "",
      lng = "";
    let coordsMatch = rest.match(/(-?\d+(\.\d+)?)[, ]+(-?\d+(\.\d+)?)/);
    if (
      coordsMatch &&
      typeof coordsMatch[1] === "string" &&
      typeof coordsMatch[3] === "string"
    ) {
      lat = coordsMatch[1];
      lng = coordsMatch[3];
    } else {
      return {
        error: true,
        message: "Invalid coordinates",
        userError:
          "Couldn't parse the coordinates of your submission. Please ensure they are in the format 'latitude, longitude' or 'latitude longitude'.",
      };
    }
    return { user, ids: [id], lat, lng, trial, team, road, field };
  }
}

// --- Utility to construct google sheets update values ---
function constructSheetValues(
  team: string,
  submissions: Submission[]
): { values: string[][]; range: string } {
  let values = [];

  const channelId = channels2.get(team);

  for (const sub of submissions) {
    if (sub.team !== team) {
      continue; // Skip submissions not for this team
    }
    values.push([
      sub.id.toString(),
      config.current_round.toString(),
      sub.lat,
      sub.lng,
      sub.user,
      "", // Reviewer
      sub.field || sub.road ? "n" : "", // Size
      sub.road ? "" : "n", // Road
      sub.field ? "" : "n", //Field
      "", // Complexity
      "", // Quality
      "n",
      sub.trial ? "y" : "n",
      "n",
    ]);
  }
  console.log(
    `Constructed ${values.length} values for team ${team} (${channelId})`
  );
  return {
    values,
    range: `${
      config.submit_channels.find((ch: any) => ch.id == channelId).sheet
    }!A${parseInt(values.length > 0 && values[0] ? values[0][0] : 1) + 4}`,
  };
}

/*
 {
            "id": "1266141785743425587",
            "bounds": {
                "lat": {
                    "max": 50,
                    "min": 43
                },
                "lng": {
                    "max": 24,
                    "min": 14
                }
            },
            "base_id": 363,
            "static_base_id": 363,
            "sheet":"Balkans"
        },
        {
            "id": "1283876323168751729",
            "bounds": {
                "lat": {
                    "max": 53,
                    "min": 50
                },
                "lng": {
                    "max": 0,
                    "min": -4
                }
            },
            "base_id": 424,
            "static_base_id": 424,
            "sheet": "UK"
        }*/